import { getBrowserContext, getAuthenticationStatus, ensureBrowserConnection } from '../browser/browser.js';
import { checkAuthentication, checkVerification } from '../browser/auth.js';
import { saveAuthToken, loadAuthToken } from '../browser/session.js';
import { isQuotaLimitDelta, quotaLimitMessage } from './quotaLimit.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logWarn, logDebug, logRaw } from '../logger/index.js';
import {
    applyFeatureConfigMode, modeForReasoningEffort, createThinkingAccumulator,
    consumeThinkingDelta, reasoningFromCompletion
} from './reasoning.js';
import {
    createNativeToolCallAccumulator, collectNativeCall, flushNativeToolCalls,
    parseToolCalls, mergeToolCalls, toolNames, toolRequiredParams, shouldRetryToolCall
} from './toolCalls.js';
import {
    isUnauthorizedResult, isUsableRefreshedToken, pickProxyOwnedQwenPage
} from './authRecovery.js';
import {
    CAPTCHA_NOTICE, detectCaptchaSignal, isCaptchaResponse, isChatInProgress,
    isProtocolTimeoutError, isNodeStreamTimeout, isVisibleBox, shouldRetryNetworkError,
    applyRetryReasoningSuppression
} from './resilience.js';
import { sendDesktopNotification } from '../utils/notify.js';
import crypto from 'crypto';
import {
    CHAT_API_URL, CREATE_CHAT_URL, CHAT_PAGE_URL, TASK_STATUS_URL,
    PAGE_TIMEOUT, RETRY_DELAY, PAGE_POOL_SIZE, USER_AGENT, NODE_STREAM_TIMEOUT_MS,
    DEFAULT_MODEL, MAX_RETRY_COUNT,
    TASK_POLL_MAX_ATTEMPTS, TASK_POLL_INTERVAL,
    CAPTCHA_POLL_INTERVAL_MS, CAPTCHA_WAIT_TIMEOUT_MS
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '..', 'AvailableModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let authToken = null;
let availableModels = null;
let authKeys = null;




const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, fallback = null) {
    return Promise.race([
        Promise.resolve(promise).catch(() => fallback),
        delay(ms).then(() => fallback)
    ]);
}

function notifyCaptcha(signal = 'verification') {
    logWarn(`Captcha requires user action (${signal})`);
    try {
        sendDesktopNotification('FreeQwenApi - captcha needs solving', CAPTCHA_NOTICE);
    } catch (e) {
        logWarn(`Could not send desktop notification: ${e.message}`);
    }
}

// Qwen keeps a 0x0 `baxia-dialog-content` iframe (_____tmd_____/punish) in the
// DOM even AFTER the slider is solved. A hidden frame must never count as an
// active captcha, otherwise waitForCaptchaClear() spins until timeout and the
// client hangs despite the user having solved it.
async function isVisibleFrame(frame) {
    if (typeof frame?.frameElement !== 'function') return true;
    const timedOut = Symbol('timeout');
    try {
        const element = await Promise.race([
            frame.frameElement().catch(() => null),
            delay(1200).then(() => timedOut)
        ]);
        if (element === timedOut) return true; // inconclusive - stay conservative
        if (!element) return false; // detached / already removed
        const box = await Promise.race([
            element.boundingBox().catch(() => null),
            delay(1200).then(() => timedOut)
        ]);
        if (box === timedOut) return true;
        if (!box) return false; // 0x0 / hidden - stale WAF dialog
        return isVisibleBox(box);
    } catch {
        return true; // cannot inspect it - keep the old, conservative behaviour
    }
}

async function readCaptchaSignal(page) {
    if (!page) return null;

    // Slider captchas normally live in an iframe; check the page AND *visible*
    // frames only (URLs first - cheap and works even when frame JS is blocked).
    let frames = [];
    try {
        frames = typeof page.frames === 'function' ? page.frames() : [];
    } catch { /* page closing */ }
    const visibleFrames = [];
    for (const frame of frames) {
        if (frame === page.mainFrame?.()) continue;
        if (await isVisibleFrame(frame)) visibleFrames.push(frame);
    }
    for (const frame of visibleFrames) {
        const frameUrl = typeof frame.url === 'function' ? (frame.url() || '') : '';
        const fromUrl = detectCaptchaSignal({ url: frameUrl });
        if (fromUrl) return fromUrl;
    }
    const pageUrl = typeof page.url === 'function' ? (page.url() || '') : '';
    const fromPageUrl = detectCaptchaSignal({ url: pageUrl });
    if (fromPageUrl) return fromPageUrl;

    const title = await withTimeout(typeof page.title === 'function' ? page.title() : null, 1500);
    const fromTitle = detectCaptchaSignal({ title: title || '' });
    if (fromTitle) return fromTitle;

    // Markers like `nc_1_nocaptcha` are id/class names, never innerText. Query
    // *visible* elements so preloaded/hidden captcha SDK containers don't fire.
    let text = '';
    try {
        text = await withTimeout(page.evaluate(() => {
            const out = [];
            const visible = (el) => {
                try {
                    const r = el.getBoundingClientRect();
                    return r.width > 1 && r.height > 1;
                } catch { return false; }
            };
            const marker = /captcha|baxia|nc_1_|_____tmd_____|slider|安全验证|滑块|拖动滑块|向右滑动|按住滑块/i;
            for (const el of document.querySelectorAll('iframe,div,span,section')) {
                if (!visible(el)) continue;
                const attrs = [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('src') || '']
                    .filter(Boolean).join(' ');
                if (marker.test(attrs)) out.push(attrs.slice(0, 300));
            }
            // Body text only counts on a sparse page (a real challenge screen).
            // A chat tab is full of conversation text that may legitimately
            // mention captcha / baxia / "security check".
            const bodyText = (document.body?.innerText || '').trim();
            if (bodyText.length < 600) out.push(bodyText);
            return out.join('\n');
        }), 1500, '');
    } catch { /* page may be navigating */ }
    const fromDom = detectCaptchaSignal({ text: text || '' });
    if (fromDom) return fromDom;

    // Finally inspect *visible* iframe documents (cross-origin is fine via CDP).
    for (const frame of visibleFrames) {
        let frameText = '';
        try {
            frameText = await withTimeout(frame.evaluate(() => {
                const html = document.documentElement?.outerHTML || '';
                return html.slice(0, 100000);
            }), 1200, '');
        } catch { /* frame gone or blocked */ }
        const fromFrame = detectCaptchaSignal({ text: frameText });
        if (fromFrame) return fromFrame;
    }
    return null;
}

// Poll the Qwen tab while a request is in flight. A captcha normally kills the
// browser fetch silently; detecting it here lets us alert the user immediately
// instead of letting the client hit a 120s protocol timeout.
function startCaptchaWatcher(page, onDetected) {
    let timer = null;
    let stopped = false;
    let resolveDetected = null;
    const detected = new Promise(resolve => { resolveDetected = resolve; });

    const tick = async () => {
        if (stopped) return;
        const signal = await readCaptchaSignal(page);
        if (stopped || !signal) return;
        stopped = true;
        if (timer) clearInterval(timer);
        notifyCaptcha(signal);
        if (typeof onDetected === 'function') {
            try {
                onDetected(signal);
            } catch (e) {
                logWarn(`Captcha client notice failed: ${e.message}`);
            }
        }
        resolveDetected(signal);
    };

    timer = setInterval(() => { tick(); }, CAPTCHA_POLL_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return {
        promise: detected,
        stop: () => { stopped = true; if (timer) clearInterval(timer); }
    };
}

async function waitForCaptchaClear(page, timeoutMs = CAPTCHA_WAIT_TIMEOUT_MS) {
    logInfo(`Waiting for captcha to be solved (max ${Math.round(timeoutMs / 1000)}s)`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const signal = await readCaptchaSignal(page);
        if (!signal) {
            logInfo('Captcha cleared; resuming request');
            return true;
        }
        await delay(CAPTCHA_POLL_INTERVAL_MS);
    }
    logWarn(`Captcha still present after ${Math.round(timeoutMs / 1000)}s`);
    return false;
}

// --- Page helpers ----------------------------------------------------------

async function getPage(context) {
    if (context && typeof context.newPage === 'function') {
        return await context.newPage();
    }

    if (context && typeof context.goto === 'function') {
        // If a Puppeteer Page was passed, don't reuse it as a worker:
        // create a separate tab from the same browser to avoid races
        // and accidental closing of the base page.
        if (typeof context.browser === 'function') {
            try {
                const browser = context.browser();
                if (browser && typeof browser.newPage === 'function') {
                    return await browser.newPage();
                }
            } catch (error) {
                logWarn(`Failed to create new page from current context: ${error.message}`);
            }
        }

        if (typeof context.isClosed === 'function' && context.isClosed()) {
            throw new Error('Base browser page is closed');
        }

        return context;
    }

    throw new Error('Invalid context: not a Puppeteer instance, not a Playwright context');
}

// Ad-hoc CDP tabs created by pagePool are routinely served a slider captcha by
// Qwen's WAF. An already-open healthy tab carries the same real session without
// adding a new browser target, so prefer it as the fetch worker. The proxy only
// runs page.evaluate(fetch(...)) there - it never navigates or closes that tab.
const CAPTCHA_SELECTOR = '#nc_1_nocaptcha, .nc_scale, [id*="nocaptcha"], iframe[src*="_____tmd_____"]';

async function isHealthyQwenPage(page) {
    try {
        if (!page || page.isClosed()) return false;
        const url = page.url();
        if (!url.includes('chat.qwen.ai') || url.includes('_____tmd_____')) return false;
        // A frozen tab must not cost a full protocolTimeout (5 min) just to
        // decide whether it is healthy.
        return await withTimeout(page.evaluate((selector) => {
            if (document.querySelector(selector)) return false;
            if ((document.body?.innerText || '').includes('Access Verification')) return false;
            try { return Boolean(localStorage.getItem('token')); } catch { return true; }
        }, CAPTCHA_SELECTOR), 5_000, false);
    } catch {
        return false;
    }
}

async function findHealthyQwenPage(context, excludePages) {
    const baseContext = getBrowserContext() || context;
    const browser = (baseContext && typeof baseContext.browser === 'function')
        ? baseContext.browser()
        : (baseContext && typeof baseContext.pages === 'function' ? baseContext : null);
    if (!browser || typeof browser.pages !== 'function') return null;

    // Include baseContext: in CDP mode it is the tab opened at startup, which
    // is exactly the healthy session tab. It is never closed by releasePage().
    const excluded = new Set(excludePages);
    const candidates = (await browser.pages()).filter(page => !excluded.has(page));
    const score = (page) => (page.url().includes('/c/') ? 1 : 0);
    candidates.sort((a, b) => score(b) - score(a));

    for (const candidate of candidates) {
        if (await isHealthyQwenPage(candidate)) return candidate;
    }
    return null;
}

export const pagePool = {
    pages: [],
    borrowed: new Map(), // shared tab -> number of requests currently using it
    maxSize: PAGE_POOL_SIZE,

    async getPage(context) {
        await ensureBrowserConnection();
        const baseContext = getBrowserContext() || context;
        while (this.pages.length > 0) {
            const page = this.pages.pop();
            try {
                if (page === baseContext) {
                    logWarn('Base page should not be in pool, skipping');
                    continue;
                }
                if (page.isClosed()) {
                    logWarn('Page from pool is closed, skipping');
                    continue;
                }
                const ready = await withTimeout(page.evaluate(() => document.readyState), 15_000, null);
                if (ready === null) throw new Error('Pooled page health check timed out');
                return page;
            } catch (e) {
                logWarn(`Page from pool is stale (${e.message?.substring(0, 60)}), creating new`);
                if (page !== baseContext) {
                    try { await page.close(); } catch { /* already dead */ }
                }
            }
        }

        // Borrow a healthy tab that is already open before spawning a fresh
        // target - new targets are what Qwen's WAF challenges with a captcha.
        const shared = await findHealthyQwenPage(baseContext, this.pages);
        if (shared) {
            this.borrowed.set(shared, (this.borrowed.get(shared) || 0) + 1);
            logInfo('Reusing existing healthy Qwen tab for API requests');
            return shared;
        }

        const newPage = await getPage(baseContext);
        await newPage.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

        if (!authToken) {
            try {
                authToken = await newPage.evaluate(() => localStorage.getItem('token'));
                logInfo('Auth token obtained from browser');
                if (authToken) {
                    saveAuthToken(authToken);
                }
            } catch (e) {
                logError('Error getting auth token', e);
            }
        }

        return newPage;
    },

    releasePage(page) {
        try {
            if (page.isClosed()) return;
        } catch { return; }

        if (this.borrowed.has(page)) {
            // Owned by the UI - never close it or push it into the worker pool.
            const remaining = this.borrowed.get(page) - 1;
            if (remaining > 0) this.borrowed.set(page, remaining);
            else this.borrowed.delete(page);
            return;
        }

        const baseContext = getBrowserContext();
        if (page === baseContext) {
            // Base page is kept separately from the pool.
            return;
        }

        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(e => logError('Error closing page', e));
        }
    },

    async clear() {
        const baseContext = getBrowserContext();
        for (const page of this.pages) {
            if (page === baseContext || this.borrowed.has(page)) continue;
            try { await page.close(); } catch (e) {
                logError('Error closing page in pool', e);
            }
        }
        this.pages = [];
        this.borrowed.clear();
    }
};

// --- Task polling ----------------------------------------------------------

export async function pollTaskStatus(taskId, page, token, maxAttempts = TASK_POLL_MAX_ATTEMPTS, interval = TASK_POLL_INTERVAL) {
    logInfo(`Starting task status polling: ${taskId}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const statusUrl = `${TASK_STATUS_URL}/${taskId}`;

            const result = await page.evaluate(async (data) => {
                try {
                    const response = await fetch(data.url, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${data.token}`,
                            'Accept': 'application/json'
                        }
                    });
                    if (!response.ok) {
                        return { success: false, status: response.status, error: await response.text() };
                    }
                    return { success: true, data: await response.json() };
                } catch (e) {
                    return { success: false, error: e.toString() };
                }
            }, { url: statusUrl, token });

            if (!result.success) {
                logWarn(`Error checking status (attempt ${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const taskData = result.data;
            const taskStatus = taskData.task_status || taskData.status || 'unknown';
            logDebug(`Task status (${attempt}/${maxAttempts}): ${taskStatus}`);

            if (taskStatus === 'completed' || taskStatus === 'success') {
                logInfo('Task completed successfully');
                return { success: true, status: 'completed', data: taskData };
            }

            if (taskStatus === 'failed' || taskStatus === 'error') {
                logError('Task failed with error');
                return { success: false, status: 'failed', error: taskData.error || taskData.message || 'Task failed with error', data: taskData };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Error polling task (attempt ${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Polling limit reached (${maxAttempts}) for task ${taskId}`);
    return { success: false, status: 'timeout', error: 'Task polling timeout exceeded' };
}

// --- Token extraction ------------------------------------------------------

export async function extractAuthToken(context, forceRefresh = false) {
    if (authToken && !forceRefresh) return authToken;

    try {
        const page = await getPage(context);
        const shouldClosePage = page !== context;
        try {
            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(RETRY_DELAY);

            const newToken = await page.evaluate(() => localStorage.getItem('token'));
            if (shouldClosePage) await page.close();

            if (newToken) {
                authToken = newToken;
                logInfo('Auth token successfully extracted');
                saveAuthToken(authToken);
                return authToken;
            }
            logError('Auth token not found in browser');
            return null;
        } catch (error) {
            if (shouldClosePage) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Error extracting auth token', error);
        return null;
    }
}

// --- Models & keys from files ----------------------------------------------

export function getAvailableModelsFromFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Models file not found: ${MODELS_FILE}`);
            return [DEFAULT_MODEL];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        logInfo('===== AVAILABLE MODELS =====');
        models.forEach(m => logInfo(`- ${m}`));
        logInfo('============================');
        return models;
    } catch (error) {
        logError('Error reading models file', error);
        return [DEFAULT_MODEL];
    }
}

function getAuthKeysFromFile() {
    try {
        if (!fs.existsSync(AUTH_KEYS_FILE)) {
            const template = `# API keys file for the proxy
# --------------------------------------------
# This file lists tokens that the proxy will
# treat as "valid".
# One key - one line without spaces.
#
# 1) Want to DISABLE authorization entirely?
#    Leave the file empty - the server will stop
#    checking the Authorization header.
#
# 2) Want to grant access to multiple people?
#    Write each key on a separate line:
#      d35ab3e1-a6f9-4d...
#      f2b1cd9c-1b2e-4a...
#
# Empty lines and lines starting with "#"
# are ignored.`;
            try {
                fs.writeFileSync(AUTH_KEYS_FILE, template, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Created keys template file: ${AUTH_KEYS_FILE}`);
            } catch (e) {
                logError('Failed to create Authorization.txt template', e);
            }
            return [];
        }
        return fs.readFileSync(AUTH_KEYS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch (error) {
        logError('Error reading auth keys file', error);
        return [];
    }
}

export function isValidModel(modelName) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return availableModels.includes(modelName);
}

export function getAllModels() {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return {
        models: availableModels.map(model => ({
            id: model,
            name: model,
            description: `Model ${model}`
        }))
    };
}

export function getApiKeys() {
    if (!authKeys) authKeys = getAuthKeysFromFile();
    return authKeys;
}

// --- sendMessage helper functions ------------------------------------------

function validateAndPrepareMessage(message) {
    if (message === null || message === undefined) {
        return { error: 'Message cannot be empty' };
    }
    if (typeof message === 'string') return { content: message };
    if (Array.isArray(message)) {
        const isValid = message.every(item =>
            (item.type === 'text' && typeof item.text === 'string') ||
            (item.type === 'image' && typeof item.image === 'string') ||
            (item.type === 'file' && typeof item.file === 'string')
        );
        if (!isValid) return { error: 'Invalid structure of composite message' };
        return { content: message };
    }
    return { error: 'Unsupported message format' };
}

// Qwen rotates the short-lived access token in localStorage roughly every
// 15 minutes. A fresh automation tab can be served a stale/long-lived token,
// so always prefer the token from the existing human Qwen tab.
async function readTokenFromQwenTab(browserContext, { includeOwned = false } = {}) {
    try {
        const base = getBrowserContext() || browserContext;
        const browser = (base && typeof base.browser === 'function') ? base.browser() : null;
        if (!browser || typeof browser.pages !== 'function') return null;

        const pooled = new Set(pagePool.pages);
        const candidates = (await browser.pages()).filter(page => {
            if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
            const url = page.url();
            if (!url.includes('chat.qwen.ai')) return false;
            // Default: prefer a human tab, which is where Qwen's own UI rotates
            // the token. After a forced reload the proxy-owned tab is also a
            // valid source (localStorage is shared per origin).
            if (!includeOwned && (page === base || pooled.has(page))) return false;
            return true;
        });
        candidates.sort((a, b) => Number(b.url().includes('/c/')) - Number(a.url().includes('/c/')));

        for (const page of candidates) {
            try {
                const token = await page.evaluate(() => localStorage.getItem('token'));
                if (token) {
                    logDebug('Fresh token read from Qwen tab');
                    return token;
                }
            } catch (e) {
                logWarn(`Could not read token from tab: ${e.message?.substring(0, 80)}`);
            }
        }
    } catch (e) {
        logWarn(`Failed to read Qwen tab token: ${e.message?.substring(0, 80)}`);
    }
    return null;
}

function tokenIsFresh(token, skewMs = 30_000) {
    return isUsableRefreshedToken(token, null, Date.now(), skewMs);
}

// Qwen rotates the short-lived token in the tab. When we catch the old one
// just before rotation, wait briefly for the page to install the replacement
// instead of firing a request that is guaranteed to return 401.
async function pollForFreshToken(browserContext, timeoutMs = 12_000, excludeToken = null, includeOwned = false) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const token = await readTokenFromQwenTab(browserContext, { includeOwned });
        // excludeToken prevents an immediate retry with the very token that
        // was just rejected (JWT can still be unexpired after a server-side rotation).
        if (isUsableRefreshedToken(token, excludeToken)) return token;
        await delay(400);
    }
    return null;
}

async function waitForFreshToken(browserContext, timeoutMs = 12_000, excludeToken = null) {
    return pollForFreshToken(browserContext, timeoutMs, excludeToken);
}

// Qwen often installs the replacement token several MINUTES after the old JWT
// expires. Waiting 12s is then guaranteed to fail. Force it: reload a tab the
// proxy owns (never the human's tab) with the token removed so the SPA asks the
// session cookie for a new one, then poll all tabs on the same origin.
async function forceFreshTokenByReload(browserContext, excludeToken = null, timeoutMs = 30_000) {
    const base = getBrowserContext() || browserContext;
    const browser = (base && typeof base.browser === 'function') ? base.browser() : null;
    if (!browser || typeof browser.pages !== 'function') return null;

    const target = pickProxyOwnedQwenPage(await browser.pages(), base, pagePool.pages);
    if (!target) {
        logWarn('No proxy-owned Qwen tab available for token refresh');
        return null;
    }
    try {
        await target.evaluate(() => {
            try { localStorage.removeItem('token'); } catch { /* storage blocked */ }
        });
        await target.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        logInfo('Reloaded proxy-owned Qwen tab to refresh token after 401');
    } catch (e) {
        logWarn(`Could not reload Qwen tab for token refresh: ${String(e.message).slice(0, 100)}`);
        return null;
    }
    return pollForFreshToken(browserContext, timeoutMs, excludeToken, true);
}

// Shared 401 recovery: give natural rotation a short chance, then force it.
async function recoverBrowserToken(browserContext, failedToken) {
    const natural = await pollForFreshToken(browserContext, 3_000, failedToken);
    if (natural) return natural;
    return forceFreshTokenByReload(browserContext, failedToken, 30_000);
}

// Single-account mode: the live Qwen tab is the source of truth. Take its
// freshest token; if it is expiring, wait for the natural rotation. Only fall
// back to the last saved token while it is still fresh, then to a full auth
// check. There is no round-robin / stored-account pool any more.
export async function resolveAuthToken(browserContext) {
    let browserToken = await readTokenFromQwenTab(browserContext);

    if (browserToken && !tokenIsFresh(browserToken)) {
        const refreshed = await waitForFreshToken(browserContext);
        if (refreshed) browserToken = refreshed;
        else {
            logWarn('Browser token is expiring and no fresh token is available yet');
            browserToken = null;
        }
    }

    if (browserToken) {
        authToken = browserToken;
        saveAuthToken(browserToken);
        logInfo('Using fresh browser token');
        return { id: 'browser', token: browserToken, source: 'browser' };
    }

    const stored = loadAuthToken();
    if (stored && tokenIsFresh(stored)) {
        authToken = stored;
        logInfo('Using saved auth token');
        return { id: 'browser', token: stored, source: 'file' };
    }

    if (!getAuthenticationStatus()) {
        logInfo('Checking authentication...');
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) return null;
    }

    if (!authToken) {
        logInfo('Getting auth token...');
        authToken = await extractAuthToken(browserContext);
    }

    return authToken ? { id: 'browser', token: authToken, source: 'browser' } : null;
}

function buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType = 't2t', size = null, reasoningMode = null, hasDeclaredTools = false) {
    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();

    const isVideo = chatType === 't2v';
    const hasCustomTools = Boolean(hasDeclaredTools || (Array.isArray(tools) && tools.length > 0));

    // Mirror the shape of a real Qwen UI request. The web API rejects older
    // hand-built payloads with Internal_Server_Error when these fields are
    // missing (notably version / chatId / parentId).
    const featureConfig = {
        thinking_enabled: true,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: true,
        thinking_mode: 'Auto',
        thinking_format: 'summary',
        auto_search: hasCustomTools && !isVideo ? false : true
    };
    if (isVideo) {
        featureConfig.auto_search = true;
    }
    // reasoning_effort selects one of Qwen's real UI modes. No mode => the
    // default Auto config above stays byte-for-byte unchanged.
    applyFeatureConfigMode(featureConfig, reasoningMode);

    const newMessage = {
        id: null,
        fid: userMessageId,
        parentId, parent_id: parentId,
        childrenIds: [assistantChildId],
        role: 'user',
        content: messageContent,
        user_action: 'chat',
        files: files || [],
        timestamp: Math.floor(Date.now() / 1000),
        models: [model],
        model: '',
        chat_type: chatType,
        feature_config: featureConfig,
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType
    };

    const payload = {
        stream: !isVideo,
        version: '2.1',
        incremental_output: true,
        chatId,
        parentId: parentId || '',
        chat_id: chatId,
        chat_mode: 'normal',
        model,
        parent_id: parentId,
        messages: [newMessage],
        timestamp: Math.floor(Date.now() / 1000)
    };

    if (size) payload.size = size;

    if (systemMessage) {
        payload.system_message = systemMessage;
        logDebug(`System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? '...' : ''}`);
    }
    if (tools && Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = toolChoice || 'auto';
    }

    return payload;
}

function parseNonSseCompletionBody(body) {
    try {
        const parsed = JSON.parse(body);
        const topLevelCode = parsed?.code;
        const nestedCode = parsed?.data?.code;
        const hasStructuredError =
            parsed?.success === false ||
            Boolean(parsed?.error) ||
            Boolean(parsed?.data?.error) ||
            Boolean(topLevelCode) ||
            Boolean(nestedCode);

        if (hasStructuredError) {
            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
            return {
                success: false,
                status: isRateLimited ? 429 : 500,
                errorBody: body
            };
        }

        const quotaDelta = parsed?.choices?.[0]?.delta || parsed?.choices?.[0]?.message;
        if (isQuotaLimitDelta(quotaDelta)) {
            return { success: false, status: 429, quotaLimited: true, errorBody: body };
        }

        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
            return { success: true, isTask: false, data: parsed };
        }
    } catch {
        // Ignore parse errors here and return a generic failure below.
    }

    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
}

export async function executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk, onReasoning = null, options = {}) {
    // Declared outside try: the catch below must be able to report whether any
    // answer chunk or reasoning chunk was already delivered, even when fetch/parse throws early.
    let hasStreamedChunks = false;
    let fullReasoning = '';
    // Idle timeout + client-disconnect cancellation share one controller.
    const controller = new AbortController();
    let idleTimer = null;
    let idleTimedOut = false;
    const armIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            controller.abort();
        }, NODE_STREAM_TIMEOUT_MS);
    };
    const onClientAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onClientAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
        if (!token) return { success: false, error: 'Auth token not found' };
        if (typeof fetch !== 'function') return { success: false, error: 'Fetch API is unavailable' };

        // Mirror the headers the browser path sends. Without the Baxia headers
        // and a Chrome UA Qwen's WAF serves a non-SSE challenge page; without a
        // single fresh X-Request-Id it answers Internal_Server_Error.
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'X-Accel-Buffering': 'no',
            'User-Agent': USER_AGENT
        };
        if (options.headers && typeof options.headers === 'object') {
            Object.assign(headers, options.headers);
        }
        // A browserless fetch needs the tab's session cookies and a normal
        // Origin/Referer or Qwen's WAF answers 200 with a non-SSE challenge.
        if (options.cookie) {
            headers['Cookie'] = options.cookie;
            try {
                const origin = new URL(apiUrl).origin;
                headers['Origin'] = origin;
                headers['Referer'] = `${origin}/`;
            } catch { /* apiUrl is always absolute in practice */ }
        }
        for (const key of Object.keys(headers)) {
            if (/^x-request-id$/i.test(key)) delete headers[key];
        }
        headers['X-Request-Id'] = crypto.randomUUID
            ? crypto.randomUUID()
            : String(Date.now()) + Math.random().toString(16).slice(2);
        headers['Authorization'] = `Bearer ${token}`;

        armIdleTimer();
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            // Without this a stalled connection hangs forever (seen as a 6.5 min
            // dead request with no log line). An idle timeout is flagged below
            // and retried on a fresh chat by isNodeStreamTimeout.
            signal: controller.signal
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        }

        if (payload.stream === false) {
            const jsonResponse = await response.json();
            const quotaDelta = jsonResponse?.choices?.[0]?.delta || jsonResponse?.choices?.[0]?.message;
            if (isQuotaLimitDelta(quotaDelta)) {
                return { success: false, status: 429, quotaLimited: true, errorBody: JSON.stringify(jsonResponse) };
            }
            // Only RateLimited code maps to 429 (gotcha #21); other errors are 500
            const hasError = jsonResponse.code || jsonResponse.error;
            if (hasError) {
                const status = jsonResponse.code === 'RateLimited' ? 429 : 500;
                return { success: false, status, errorBody: JSON.stringify(jsonResponse) };
            }
            return { success: true, isTask: true, data: jsonResponse };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const body = await response.text();
            return parseNonSseCompletionBody(body);
        }

        const reader = response.body?.getReader?.();
        if (!reader) {
            const body = await response.text();
            return parseNonSseCompletionBody(body);
        }

        const decoder = new TextDecoder();
        const thinkingState = createThinkingAccumulator();
        const allowedToolNames = options.allowedToolNames instanceof Set ? options.allowedToolNames : null;
        const nativeAcc = allowedToolNames ? createNativeToolCallAccumulator() : null;
        let buffer = '';
        let fullContent = '';
        let responseId = null;
        let usage = null;
        let finished = false;
        let streamError = null;

        const processSseLine = (rawLine) => {
            const line = rawLine.trim();
            if (!line || !line.startsWith('data:')) return;

            const jsonStr = line.substring(5).trim();
            if (!jsonStr) return;
            if (jsonStr === '[DONE]') {
                finished = true;
                return;
            }

            try {
                const chunk = JSON.parse(jsonStr);

                if (chunk.code === 'RateLimited') {
                    const errBody = JSON.stringify(chunk);
                    logWarn(`[upstream-error] stream status=429 model=${payload?.model || 'n/a'} chat_id=${payload?.chat_id || 'n/a'} body=${errBody.slice(0, 500)}`);
                    streamError = { status: 429, errorBody: errBody };
                    finished = true;
                    return;
                }
                // Other structured error chunks (ContentFiltered, quota, FAIL_SYS_USER_VALIDATE…)
                // must surface immediately as 500, not fall through to network-error retry (R3).
                if (chunk.code && !chunk.choices) {
                    const errBody = JSON.stringify(chunk);
                    logWarn(`[upstream-error] stream structured-error code=${chunk.code} model=${payload?.model || 'n/a'} chat_id=${payload?.chat_id || 'n/a'} body=${errBody.slice(0, 500)}`);
                    streamError = { status: 500, errorBody: errBody };
                    finished = true;
                    return;
                }
                if (chunk.error && !chunk.choices) {
                    const errBody = JSON.stringify(chunk);
                    logWarn(`[upstream-error] stream status=500 model=${payload?.model || 'n/a'} chat_id=${payload?.chat_id || 'n/a'} body=${errBody.slice(0, 500)}`);
                    streamError = { status: 500, errorBody: errBody };
                    finished = true;
                    return;
                }

                if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                if (chunk.response_id) responseId = chunk.response_id;

                if (chunk.choices && chunk.choices[0]) {
                    const delta = chunk.choices[0].delta || chunk.choices[0].message;
                    // Qwen signals daily quota with HTTP 200 + extra.update_member.
                    // Detect BEFORE forwarding any content so the quota notice is
                    // never streamed to the client as an answer (gotcha #35).
                    if (isQuotaLimitDelta(delta)) {
                        const errBody = JSON.stringify(chunk);
                        logWarn(`[quota-limit] model=${payload?.model || 'n/a'} chat_id=${payload?.chat_id || 'n/a'}`);
                        streamError = { status: 429, quotaLimited: true, errorBody: errBody };
                        finished = true;
                        return;
                    }
                    if (nativeAcc && delta?.function_call) {
                        collectNativeCall(nativeAcc, delta.function_call, allowedToolNames);
                    }
                    if (nativeAcc && Array.isArray(delta?.tool_calls)) {
                        for (const tc of delta.tool_calls) {
                            const fn = tc?.function || tc;
                            collectNativeCall(nativeAcc, { id: tc?.id ?? tc?.index, name: fn?.name, arguments: fn?.arguments }, allowedToolNames);
                        }
                    }
                    const { reasoning, content } = consumeThinkingDelta(thinkingState, delta);
                    if (content) {
                        fullContent += content;
                        if (typeof onChunk === 'function') {
                            onChunk(content);
                            hasStreamedChunks = true;
                        }
                    }
                    if (reasoning) {
                        fullReasoning += reasoning;
                        if (typeof onReasoning === 'function') onReasoning(reasoning);
                    }
                    // Qwen ends thinking_summary with status:"finished" before
                    // it sends answer chunks; only a finished answer ends the stream.
                    if (delta && delta.status === 'finished' && (!delta.phase || delta.phase === 'answer')) finished = true;
                    if (chunk.choices[0].finish_reason) finished = true;
                }

                if (chunk.usage) usage = chunk.usage;
            } catch {
                // Ignore broken chunks, keep reading stream.
            }
        };

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdleTimer();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
                processSseLine(rawLine);
                if (finished) break;
            }
        }
        if (!finished && buffer.trim()) {
            processSseLine(buffer);
        }

        // We may stop at status:"finished" before EOF; release the connection.
        reader.cancel().catch(() => {});

        if (streamError) {
            return { success: false, ...streamError, hasStreamedChunks, hasStreamedReasoning: fullReasoning.length > 0 };
        }

        if (!finished) {
            return {
                success: false,
                error: 'Stream closed before completion',
                interrupted: true,
                hasStreamedChunks,
                hasStreamedReasoning: fullReasoning.length > 0
            };
        }

        const native = nativeAcc ? flushNativeToolCalls(nativeAcc, allowedToolNames) : { calls: [], dropped: [] };
        const resultData = {
            id: responseId || 'chatcmpl-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: payload.model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: fullContent,
                    ...(fullReasoning ? { reasoning_content: fullReasoning } : {})
                },
                finish_reason: 'stop'
            }],
            usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            response_id: responseId
        };
        if (native.calls.length > 0) resultData.native_tool_calls = native.calls;
        if (native.dropped.length > 0) resultData.native_tool_dropped = native.dropped;

        return {
            success: true,
            isTask: false,
            hasStreamedChunks,
            hasStreamedReasoning: fullReasoning.length > 0,
            data: resultData
        };
    } catch (error) {
        const text = error?.toString ? error.toString() : String(error);
        const nodeTimeout = idleTimedOut || error?.name === 'TimeoutError' || /aborted due to timeout|operation timed out/i.test(text);
        const message = idleTimedOut ? `TimeoutError: no data from Qwen for ${NODE_STREAM_TIMEOUT_MS}ms` : text;
        // Preserve this flag: retrying after partial SSE output would duplicate
        // already-delivered text in the client.
        // Fix (R9): propagate hasStreamedReasoning from the catch path so the
        // stream-timeout/interrupt retry (handleApiError) can suppress duplicate
        // reasoning — fullReasoning is declared in the outer function scope.
        return { success: false, error: message, nodeTimeout, hasStreamedChunks, hasStreamedReasoning: fullReasoning.length > 0 };
    } finally {
        clearTimeout(idleTimer);
        options.signal?.removeEventListener('abort', onClientAbort);
    }
}

// Qwen's Aliyun WAF (Baxia) challenges requests that lack the bx-ua/bx-umidtoken
// headers generated by et_f.js in the browser. session/baxia.json stores a set
// captured from one real UI request; they live for the whole session.
const BAXIA_HEADERS_FILE = path.join(__dirname, '..', '..', 'session', 'baxia.json');

export function loadBaxiaHeaders() {
    try {
        if (!fs.existsSync(BAXIA_HEADERS_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(BAXIA_HEADERS_FILE, 'utf8'));
        const src = raw.headers || raw.extraHeaders || raw;
        const out = {};
        const seen = new Set();
        for (const [k, v] of Object.entries(src)) {
            if (/^(cookie|content-length|host|authorization|accept-encoding|connection|x-request-id)$/i.test(k)) continue;
            // Headers normalizes casing: sending both "Version" and "version"
            // produces one comma-joined value, which Qwen rejects.
            const norm = k.toLowerCase();
            if (seen.has(norm)) continue;
            seen.add(norm);
            out[k] = String(v);
        }
        return Object.keys(out).length ? out : null;
    } catch (e) {
        logWarn(`Failed to read ${BAXIA_HEADERS_FILE}: ${e.message}`);
        return null;
    }
}

// `loadBaxiaHeaders()` deliberately drops cookies (the browser supplies them
// itself). A Node fetch has no browser cookie jar, so copy the Qwen cookies
// from the worker tab before using the streaming path.
async function qwenCookieHeader(page) {
    try {
        const client = await page.createCDPSession();
        try {
            const { cookies } = await client.send('Network.getAllCookies');
            const cookie = cookies
                .filter(c => /(^|\.)qwen\.ai$/.test(c.domain))
                .map(c => `${c.name}=${c.value}`)
                .join('; ');
            return cookie || null;
        } finally {
            await client.detach();
        }
    } catch (e) {
        logWarn(`Could not read Qwen cookies for node streaming: ${e.message}`);
        return null;
    }
}

// Qwen web tokens live ~15 minutes; the page keeps refreshing them. Take the
// freshest token straight from the tab before each request.
async function syncTokenFromPage(page, tokenObj = null) {
    try {
        const fresh = await readTokenFromQwenTab(getBrowserContext())
            || await page.evaluate(() => localStorage.getItem('token'));
        if (!fresh || fresh === authToken) return;
        authToken = fresh;
        saveAuthToken(fresh);
        logInfo('Token updated from browser');
    } catch (e) {
        logWarn(`Failed to update token from browser: ${e.message}`);
    }
}

// Deletes a chat from Qwen history. Used for one-shot chats
// created for requests without conversation_id (OpenCode etc.).
export async function deleteChatV2(chatId) {
    if (!chatId) return false;

    const browserContext = getBrowserContext();
    if (!browserContext) return false;

    let page = null;
    try {
        const tokenObj = await resolveAuthToken(browserContext);
        page = await pagePool.getPage(browserContext);
        await syncTokenFromPage(page, tokenObj);

        const headers = loadBaxiaHeaders() || {};
        const result = await page.evaluate(async ({ id, token, extraHeaders }) => {
            try {
                const h = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'X-Request-Id': crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)
                };
                for (const [k, v] of Object.entries(extraHeaders || {})) h[k] = v;
                h['Authorization'] = `Bearer ${token}`;

                const response = await fetch(`/api/v2/chats/${id}`, {
                    method: 'DELETE',
                    credentials: 'include',
                    headers: h
                });
                return { ok: response.ok, status: response.status, body: (await response.text()).slice(0, 200) };
            } catch (e) {
                return { ok: false, error: e.toString() };
            }
        }, { id: chatId, token: authToken, extraHeaders: headers });

        if (result.ok) {
            logInfo(`[chat-cleanup] deleted chat ${chatId} status=${result.status}`);
            return true;
        }
        logWarn(`[chat-cleanup] failed chat ${chatId} status=${result.status || 'n/a'} error=${result.error || ''} body=${(result.body || '').slice(0, 120)}`);
        return false;
    } catch (e) {
        logWarn(`[chat-cleanup] exception deleting chat ${chatId}: ${e.message}`);
        return false;
    } finally {
        if (page) pagePool.releasePage(page);
    }
}

async function executeApiRequest(page, apiUrl, payload, token, onChunk = null, onReasoning = null, options = {}) {
    const baxiaHeaders = loadBaxiaHeaders();
    const allowedToolNames = options.allowedToolNames instanceof Set ? Array.from(options.allowedToolNames) : null;
    const collectOnly = options.collectOnly === true;
    const wantsStreaming = payload?.stream !== false && (typeof onChunk === 'function' || collectOnly);
    // With the captured Baxia headers + real UA + tab cookies a Node fetch passes
    // Qwen's WAF, so every streaming request uses it: the client gets real
    // incremental output and no single page.evaluate can hit protocolTimeout.
    // A WAF challenge still falls back to the browser fetch below.
    const useNodeStreaming = wantsStreaming;

    // Watch the tab from the start: a captcha can appear during the Node fetch
    // too, and the browser fallback below needs the same watcher instance.
    const captchaWatcher = startCaptchaWatcher(page, () => {
        const notify = typeof options.onCaptcha === 'function'
            ? options.onCaptcha
            : (typeof onChunk === 'function' ? onChunk : null);
        if (notify) notify(CAPTCHA_NOTICE);
    });

    if (useNodeStreaming) {
        const cookie = await qwenCookieHeader(page);
        const streamedResponse = await executeApiRequestWithNodeStreaming(
            apiUrl, payload, token,
            typeof onChunk === 'function' ? onChunk : null,
            onReasoning,
            { ...options, headers: baxiaHeaders || undefined, cookie }
        );

        // Qwen's Aliyun WAF blocks a browserless fetch lacking the real session
        // headers and returns a non-SSE challenge page. Do NOT return that -
        // fall through to browser evaluate, which carries the actual session.
        const wafBlockedNodeStream =
            streamedResponse.success !== true &&
            /Unexpected non-SSE 200/i.test(String(streamedResponse.error || ''));

        // Thinking already reached the client: do not re-POST into the same chat.
        if (!streamedResponse.success && !streamedResponse.status && streamedResponse.hasStreamedReasoning
            && !streamedResponse.hasStreamedChunks) {
            captchaWatcher.stop();
            return { ...streamedResponse, interrupted: true };
        }

        const canReturnDirectly = options.signal?.aborted || !wafBlockedNodeStream && (
            streamedResponse.success ||
            streamedResponse.interrupted === true ||
            streamedResponse.nodeTimeout === true ||
            Boolean(streamedResponse.status) ||
            Boolean(streamedResponse.errorBody) ||
            streamedResponse.hasStreamedChunks === true
        );

        if (canReturnDirectly) {
            captchaWatcher.stop();
            // Collect-only output went to an internal sink: the client has seen
            // nothing, so a broken stream is safe to retry (on a fresh chat).
            if (collectOnly && streamedResponse.success !== true && streamedResponse.hasStreamedChunks) {
                return { ...streamedResponse, hasStreamedChunks: false, interrupted: !streamedResponse.status };
            }
            return streamedResponse;
        }

        logWarn(`Node-streaming unavailable (${streamedResponse.error || 'unknown error'}), falling back to browser fetch.`);
    }

    const requestBody = { apiUrl, payload, token, headers: baxiaHeaders || null, allowedToolNames };

    logDebug(`Using token: ${token ? 'Session token' : 'No token'}`);
    logDebug(`API URL: ${apiUrl}`);

    let rawPromise;
    try {
        rawPromise = page.evaluate(async (data) => {
        try {
            // Mirrors src/api/reasoning.js: page.evaluate cannot import ES modules.
            const partsText = (v) => {
                if (typeof v === 'string') return v;
                if (Array.isArray(v)) return v.map(partsText).join('');
                if (v && typeof v === 'object') {
                    if (typeof v.text === 'string') return v.text;
                    if (v.content !== undefined) return partsText(v.content);
                }
                return '';
            };
            const joinParts = (v, sep) => {
                const raw = (v && typeof v === 'object' && !Array.isArray(v) && v.content !== undefined) ? v.content : v;
                const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
                return list.map(p => partsText(p).trim()).filter(Boolean).join(sep);
            };
            const normalizeToolName = (name) => {
                let n = String(name || '').trim();
                const lower = n.toLowerCase();
                for (const p of ['functions.', 'default_api.']) {
                    if (lower.startsWith(p)) { n = n.slice(p.length); break; }
                }
                return n.trim();
            };
            const jsonComplete = (s) => {
                const t = String(s || '').trim();
                if (!t.startsWith('{') && !t.startsWith('[')) return false;
                try { JSON.parse(t); return true; } catch { return false; }
            };
            const parseArgsObject = (rawArgs) => {
                if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return { ok: true, value: rawArgs };
                const t = typeof rawArgs === 'string' ? rawArgs.trim() : '';
                if (!t) return { ok: true, value: {} };
                try {
                    const parsed = JSON.parse(t);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed };
                    return { ok: false, error: 'arguments must be a JSON object' };
                } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
            };
            const allowedToolNames = Array.isArray(data.allowedToolNames) ? new Set(data.allowedToolNames) : null;
            const nativeCalls = [];
            const collectNative = (fc) => {
                if (!fc || !allowedToolNames) return;
                const name = normalizeToolName(fc.name || (fc.function && fc.function.name) || '');
                const rawArgs = typeof fc.arguments === 'string' ? fc.arguments
                    : (fc.arguments ? JSON.stringify(fc.arguments)
                    : (typeof (fc.function && fc.function.arguments) === 'string' ? fc.function.arguments
                    : (fc.function && fc.function.arguments ? JSON.stringify(fc.function.arguments) : '')));
                const cid = String(fc.id ?? fc.call_id ?? fc.tool_call_id ?? fc.index ?? '').trim();
                let call = null;
                if (cid) {
                    call = nativeCalls.find(c => c.cid === cid && (!name || !c.name || c.name === name)) || null;
                    if (!call) { call = { cid, name, arguments: '' }; nativeCalls.push(call); }
                } else {
                    call = nativeCalls[nativeCalls.length - 1] || null;
                    const newByName = !!(name && call && call.name && call.name !== name);
                    const boundary = !!(call && rawArgs && jsonComplete(call.arguments) && String(rawArgs).trim().startsWith('{') && !String(rawArgs).startsWith(call.arguments));
                    if (!call || newByName || boundary) { call = { cid: '', name, arguments: '' }; nativeCalls.push(call); }
                }
                if (name) call.name = name;
                if (!rawArgs) return;
                const prev = call.arguments || '';
                if (!prev) call.arguments = rawArgs;
                else if (rawArgs.startsWith(prev)) call.arguments = rawArgs;
                else if (prev.startsWith(rawArgs)) { /* keep */ }
                else call.arguments += rawArgs;
            };
            const flushNative = () => {
                const out = { calls: [], dropped: [] };
                for (const entry of nativeCalls) {
                    const name = normalizeToolName(entry.name || '');
                    if (!name) continue;
                    if (allowedToolNames && !allowedToolNames.has(name)) { out.dropped.push('undeclared tool: ' + name); continue; }
                    const rawArgs = String(entry.arguments || '').trim() || '{}';
                    const parsed = parseArgsObject(rawArgs);
                    if (!parsed.ok) { out.dropped.push('unusable arguments for ' + name + ': ' + parsed.error); continue; }
                    out.calls.push({
                        id: String(entry.cid || ('call_' + Math.random().toString(16).slice(2) + Date.now().toString(16))),
                        type: 'function',
                        function: { name, arguments: JSON.stringify(parsed.value) },
                        index: out.calls.length
                    });
                }
                return out;
            };
            const thinkState = { thought: '', seenTitles: [], blockFinished: false };
            const consumeThinking = (delta) => {
                const out = { reasoning: '', content: '' };
                if (!delta || typeof delta !== 'object') return out;
                const phase = String(delta.phase || '').toLowerCase();
                const status = String(delta.status || '').toLowerCase();
                const isSummary = phase.includes('summary');
                const isThinking = !isSummary && (phase === 'thinking' || phase === 'think' || phase === 'reasoning');
                const body = delta.content ?? delta.text ?? delta.output_text;
                const directReasoning = partsText(delta.reasoning_content);
                if (directReasoning) out.reasoning += directReasoning;
                else if (isThinking) out.reasoning += partsText(body);
                if (isSummary) {
                    if (status === 'finished') { thinkState.blockFinished = true; return out; }
                    const extra = delta.extra || {};
                    const rawTitles = extra.summary_title && typeof extra.summary_title === 'object'
                        && Object.prototype.hasOwnProperty.call(extra.summary_title, 'content')
                        ? extra.summary_title.content : extra.summary_title;
                    const titleList = Array.isArray(rawTitles) ? rawTitles : (rawTitles ? [rawTitles] : []);
                    for (const item of titleList) {
                        const title = partsText(item).trim();
                        if (title && !thinkState.seenTitles.includes(title)) {
                            thinkState.seenTitles.push(title);
                            out.reasoning += `**${title}**\n\n`;
                        }
                    }
                    const thoughtText = joinParts(extra.summary_thought, '\n\n');
                    if (thoughtText && thoughtText !== thinkState.thought) {
                        let added = '';
                        if (thinkState.thought && thoughtText.startsWith(thinkState.thought)) {
                            added = thoughtText.slice(thinkState.thought.length);
                            thinkState.thought = thoughtText;
                        } else if (thinkState.blockFinished && !thoughtText.startsWith(thinkState.thought)) {
                            added = '\n\n' + thoughtText;
                            thinkState.thought = (thinkState.thought ? thinkState.thought + '\n\n' : '') + thoughtText;
                        } else if (!thinkState.thought) {
                            added = thoughtText;
                            thinkState.thought = thoughtText;
                        } else {
                            let p = 0;
                            while (p < thinkState.thought.length && p < thoughtText.length && thinkState.thought[p] === thoughtText[p]) p++;
                            added = thoughtText.slice(p);
                            thinkState.thought = thoughtText;
                        }
                        thinkState.blockFinished = false;
                        if (added) out.reasoning += added;
                    }
                    return out;
                }
                if (isThinking) return out;
                out.content += partsText(body);
                return out;
            };

            // Mirror src/api/quotaLimit.js inside the page context (no ES module
            // imports available here). Qwen signals daily quota with HTTP 200 +
            // extra.update_member, not a RateLimited code (gotcha #35).
            const isQuotaDelta = (delta) => {
                if (!delta) return false;
                if (delta.extra && 'update_member' in delta.extra) return delta.extra.update_member === true;
                const content = delta.content || '';
                if (typeof content !== 'string') return false;
                if (delta.status !== 'finished') return false;
                if (content.length > 300) return false;
                return /you'?ve reached today'?s .+ limit|upgrade your membership|switch to another model/i.test(content);
            };

            const t = data.token;
            if (!t) return { success: false, error: 'Auth token not found' };

            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${t}`,
                'Accept': 'application/json',
                'X-Accel-Buffering': 'no'
            };
            if (data.headers) {
                for (const [k, v] of Object.entries(data.headers)) headers[k] = v;
                headers['Authorization'] = `Bearer ${t}`;
            }
            // The UI always sends exactly one request id. baxia headers no longer
            // carry one (loadBaxiaHeaders strips it), so add a fresh single id
            // here. Sending two made Qwen reject with Internal_Server_Error.
            headers['X-Request-Id'] = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);

            const response = await fetch(data.apiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(data.payload)
            });

            if (response.ok) {
                if (data.payload.stream === false) {
                    const jsonResponse = await response.json();
                    const quotaDelta = jsonResponse?.choices?.[0]?.delta || jsonResponse?.choices?.[0]?.message;
                    if (isQuotaDelta(quotaDelta)) {
                        return { success: false, status: 429, quotaLimited: true, errorBody: JSON.stringify(jsonResponse) };
                    }
                    // Only RateLimited code maps to 429 (gotcha #21); other errors are 500
                    const hasError = jsonResponse.code || jsonResponse.error;
                    if (hasError) {
                        const status = jsonResponse.code === 'RateLimited' ? 429 : 500;
                        return { success: false, status, errorBody: JSON.stringify(jsonResponse) };
                    }
                    return { success: true, isTask: true, data: jsonResponse };
                }

                const contentType = response.headers.get('content-type') || '';

                if (!contentType.includes('text/event-stream')) {
                    const body = await response.text();
                    try {
                        const parsed = JSON.parse(body);
                        const topLevelCode = parsed?.code;
                        const nestedCode = parsed?.data?.code;
                        const hasStructuredError =
                            parsed?.success === false ||
                            Boolean(parsed?.error) ||
                            Boolean(parsed?.data?.error) ||
                            Boolean(topLevelCode) ||
                            Boolean(nestedCode);

                        // API sometimes returns JSON with success=false and code at HTTP 200.
                        if (hasStructuredError) {
                            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
                            return {
                                success: false,
                                status: isRateLimited ? 429 : 500,
                                errorBody: body
                            };
                        }
                        // Valid JSON completion response (sometimes Qwen returns this way)
                        const quotaDelta = parsed?.choices?.[0]?.delta || parsed?.choices?.[0]?.message;
                        if (isQuotaDelta(quotaDelta)) {
                            return { success: false, status: 429, quotaLimited: true, errorBody: body };
                        }
                        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
                            return { success: true, isTask: false, data: parsed };
                        }
                    } catch { /* not JSON, treat as unexpected */ }
                    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';
                let fullReasoning = '';
                let responseId = null;
                let usage = null;
                let finished = false;
                let streamError = null;

                const processBrowserSseLine = (rawLine) => {
                    const trimmedLine = rawLine.trim();
                    if (!trimmedLine || !trimmedLine.startsWith('data:')) return;
                    const jsonStr = trimmedLine.substring(5).trim();
                    if (!jsonStr) return;
                    if (jsonStr === '[DONE]') {
                        finished = true;
                        return;
                    }
                    try {
                        const chunk = JSON.parse(jsonStr);

                        if (chunk.code === 'RateLimited') {
                            streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                            finished = true;
                            return;
                        }
                        // Other structured error chunks (ContentFiltered, quota, FAIL_SYS_USER_VALIDATE…)
                        // surface as 500 immediately — do NOT retry as network errors (R3).
                        if (chunk.code && !chunk.choices) {
                            streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                            finished = true;
                            return;
                        }
                        if (chunk.error && !chunk.choices) {
                            streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                            finished = true;
                            return;
                        }

                        if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                        if (chunk.response_id) responseId = chunk.response_id;
                        if (chunk.choices && chunk.choices[0]) {
                            const choice = chunk.choices[0];
                            const delta = choice.delta || choice.message;
                            if (isQuotaDelta(delta)) {
                                streamError = { status: 429, quotaLimited: true, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                return;
                            }
                            if (delta && delta.function_call) collectNative(delta.function_call);
                            if (delta && Array.isArray(delta.tool_calls)) {
                                for (const tc of delta.tool_calls) {
                                    const fn = tc.function || tc;
                                    collectNative({ id: tc.id ?? tc.index, name: fn.name, arguments: fn.arguments });
                                }
                            }
                            const { reasoning, content } = consumeThinking(delta);
                            fullReasoning += reasoning;
                            fullContent += content;
                            if (delta && delta.status === 'finished' && (!delta.phase || delta.phase === 'answer')) finished = true;
                            if (choice.finish_reason) finished = true;
                        }
                        if (chunk.usage) usage = chunk.usage;
                    } catch { /* ignore parse errors for individual chunks */ }
                };

                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        processBrowserSseLine(line);
                        if (finished) break;
                    }
                }
                if (!finished && buffer.trim()) {
                    processBrowserSseLine(buffer);
                }

                if (streamError) {
                    return { success: false, ...streamError };
                }

                if (!finished) {
                    return { success: false, error: 'Stream closed before completion', interrupted: true, hasStreamedReasoning: fullReasoning.length > 0 };
                }

                const native = flushNative();
                const resultData = {
                    id: responseId || 'chatcmpl-' + Date.now(),
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: data.payload.model,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: fullContent,
                            ...(fullReasoning ? { reasoning_content: fullReasoning } : {})
                        },
                        finish_reason: 'stop'
                    }],
                    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    response_id: responseId
                };
                if (native.calls.length > 0) resultData.native_tool_calls = native.calls;
                if (native.dropped.length > 0) resultData.native_tool_dropped = native.dropped;
                return {
                    success: true,
                    isTask: false,
                    hasStreamedReasoning: fullReasoning.length > 0,
                    data: resultData
                };
            }

            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        } catch (error) {
            return { success: false, error: error.toString() };
        }
        }, requestBody);
    } catch (e) {
        captchaWatcher.stop();
        return { success: false, error: String(e) };
    }

    let outcome;
    try {
        outcome = await Promise.race([
            rawPromise.then(value => ({ type: 'response', value })),
            captchaWatcher.promise.then(signal => ({ type: 'captcha', signal }))
        ]);
    } finally {
        captchaWatcher.stop();
    }

    if (outcome.type === 'captcha') {
        // Let the abandoned evaluate settle before the page goes back to the pool.
        await Promise.race([rawPromise.catch(() => {}), delay(10_000)]);
        const cleared = await waitForCaptchaClear(page);
        return {
            success: false,
            captcha: true,
            retryable: cleared,
            error: CAPTCHA_NOTICE
        };
    }
    return outcome.value;
}

async function handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk = null, options = {}, tools = null, toolChoice = null, systemMessage = null) {
    logRaw(JSON.stringify(response));
    const errorDetail = response.error || response.statusText
        || (typeof response.errorBody === 'string' ? response.errorBody.slice(0, 300) : 'unknown error');
    if (response.captcha || isCaptchaResponse(response)) logWarn(`Captcha flow: ${errorDetail}`);
    else logError(`Error getting response: ${errorDetail}`);
    if (response.errorBody) logDebug(`Error response body: ${response.errorBody}`);

    // Nobody is listening any more: do not burn quota on retries.
    if (options.signal?.aborted) return { error: 'Client disconnected', aborted: true, chatId };

    // Captcha: the watcher already notified the user and waited for the slider
    // to be solved. The original browser fetch died when the WAF challenged it,
    // but Qwen's server-side generation may still be running in this chat.
    // Retrying the SAME chat then gets 500 CHAT_IN_PROGRESS, so start a fresh
    // chat (full history is resent in `messages`). A captcha seen only in the
    // response body can't be waited on, so return an actionable message.
    const retryOpts = applyRetryReasoningSuppression(options, response);
    if (response.captcha || isCaptchaResponse(response)) {
        if (response.captcha && response.retryable && retryCount < MAX_RETRY_COUNT) {
            logInfo('Captcha solved; retrying request on a fresh chat');
            if (chatId && !options.keepChat) deleteChatV2(chatId).catch(() => {});
            await delay(RETRY_DELAY);
            return sendMessage(message, model, null, null, files, tools, toolChoice, systemMessage, chatType, size, waitForCompletion, retryCount + 1, onChunk, retryOpts);
        }
        if (!response.captcha) notifyCaptcha('response-body');
        return { error: CAPTCHA_NOTICE, verification: true, captcha: true, chatId };
    }

    // Qwen still generating the previous answer (commonly the request that the
    // captcha interrupted). Never replay into that chat - switch to a new one.
    if (isChatInProgress(response)) {
        if (retryCount < MAX_RETRY_COUNT) {
            logWarn(`Qwen chat still in progress; retrying on a fresh chat (${retryCount + 1}/${MAX_RETRY_COUNT})`);
            if (chatId && !options.keepChat) deleteChatV2(chatId).catch(() => {});
            await delay(RETRY_DELAY);
            return sendMessage(message, model, null, null, files, tools, toolChoice, systemMessage, chatType, size, waitForCompletion, retryCount + 1, onChunk, retryOpts);
        }
        return { error: 'Qwen is still generating the previous answer. Please retry shortly.', chatId };
    }

    // Puppeteer cancelled a CDP call after protocolTimeout, or the Node fetch
    // stalled past NODE_STREAM_TIMEOUT_MS. Qwen may still be generating
    // server-side, so retry on a NEW chat like CHAT_IN_PROGRESS instead of
    // replaying into the abandoned one. Never surface the raw
    // `Error: ProtocolError...` / `TimeoutError...` string to the client.
    if ((response.protocolTimeout || response.interrupted || isProtocolTimeoutError(response) || isNodeStreamTimeout(response)) && response.hasStreamedChunks !== true) {
        if (retryCount < MAX_RETRY_COUNT) {
            logWarn(`Stream timeout/interruption; retrying on a fresh chat (${retryCount + 1}/${MAX_RETRY_COUNT})`);
            if (chatId && !options.keepChat) deleteChatV2(chatId).catch(() => {});
            await delay(RETRY_DELAY);
            return sendMessage(message, model, null, null, files, tools, toolChoice, systemMessage, chatType, size, waitForCompletion, retryCount + 1, onChunk, retryOpts);
        }
        return { error: 'Qwen did not respond in time. Please retry shortly.', chatId, timeout: true };
    }

    // Transient browser/network failures (WAF reset, socket hang up, tab
    // navigation) previously went straight to the client. Retry the same chat
    // a bounded number of times; never replay an already-streamed answer.
    if (shouldRetryNetworkError(response, retryCount, MAX_RETRY_COUNT)) {
        logWarn(`Transient network error; retrying same chat (${retryCount + 1}/${MAX_RETRY_COUNT}) in ${RETRY_DELAY}ms`);
        await delay(RETRY_DELAY);
        return sendMessage(message, model, chatId, parentId, files, tools, toolChoice, systemMessage, chatType, size, waitForCompletion, retryCount + 1, onChunk, retryOpts);
    }

    if (response.status === 401 || (response.errorBody && (response.errorBody.includes('Unauthorized') || response.errorBody.includes('Token has expired')))) {
        logWarn('Browser token rejected (401); attempting refresh.');
        if (response.errorBody) logWarn(`401 response body: ${String(response.errorBody).slice(0, 300)}`);
        authToken = null;

        // A browser token can be rejected simply because Qwen rotated it a
        // second before our request. Wait for the natural rotation, or force a
        // reload of the proxy-owned tab, then retry the SAME chat.
        if (retryCount < MAX_RETRY_COUNT) {
            const fresh = await recoverBrowserToken(getBrowserContext(), tokenObj?.token);
            if (fresh) {
                authToken = fresh;
                saveAuthToken(fresh);
                logInfo('Retrying with freshly rotated browser token');
                return sendMessage(message, model, chatId, parentId, files, tools, toolChoice, systemMessage, chatType, size, waitForCompletion, retryCount + 1, onChunk, retryOpts);
            }
        }
        logError('No fresh token available; re-authentication required.');
        return { error: 'Qwen session expired (401). Please log in again in the Chrome window.', status: 401, chatId };
    }

    // Quota / rate limit is terminal in single-account mode: no rotation, no
    // retry. Surface a clean 429 so the client stops and keeps history clean.
    if (response.quotaLimited || response.status === 429) {
        if (response.quotaLimited) {
            return { error: quotaLimitMessage(model), status: 429, quotaLimited: true, chatId };
        }
        return { error: 'Qwen rate limit reached. Please wait before retrying.', status: 429, chatId };
    }

    let errorMessage = response.error || response.statusText;
    if (!errorMessage && response.errorBody) {
        try {
            const parsed = JSON.parse(response.errorBody);
            errorMessage = parsed?.data?.code || parsed?.code || parsed?.message || 'Qwen API error';
        } catch {
            errorMessage = String(response.errorBody).slice(0, 200);
        }
    }
    return { error: errorMessage || 'Request failed', details: response.errorBody || 'No additional details', chatId };
}

// --- Main public API -------------------------------------------------------

// Normalize native + text tool calls for EVERY response, including the nudge
// retry. The old code only did it for the first answer, so a valid text tool
// call in the retried answer leaked into `content` as plain text (see the
// `todowrite` fence left as text in opencode session ses_df45b870...).
function finalizeToolCallsInResponse(response, allowedToolNames, requiredToolParams) {
    if (!response?.success || response.isTask || !allowedToolNames || !response.data) {
        return { merged: [], dropped: [], textDropped: [], cleanText: '' };
    }
    const content = response.data.choices?.[0]?.message?.content || '';
    const nativeCalls = Array.isArray(response.data.native_tool_calls) ? response.data.native_tool_calls : [];
    const nativeDropped = Array.isArray(response.data.native_tool_dropped) ? response.data.native_tool_dropped : [];
    const parsed = parseToolCalls(content, allowedToolNames, requiredToolParams);
    const merged = mergeToolCalls(nativeCalls, parsed.calls);
    const dropped = [...nativeDropped, ...parsed.dropped];

    if (merged.length > 0) response.data.tool_calls_normalized = merged;
    else delete response.data.tool_calls_normalized;
    if (dropped.length > 0) response.data.tool_calls_dropped = dropped;
    // Prose around the call must survive even when normalized calls are present.
    response.data.tool_calls_clean_text = parsed.text;
    return { merged, dropped, textDropped: parsed.dropped, cleanText: parsed.text };
}

export async function sendMessage(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0, onChunk = null, options = {}) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Browser is not initialized', chatId };
    if (options.signal?.aborted) return { error: 'Client disconnected', aborted: true, chatId };

    // Resolve the token ONCE: the same token must create the chat and send the
    // message, otherwise Qwen returns "chat is not exist".
    const tokenObj = options.tokenObj || await resolveAuthToken(browserContext);
    if (!tokenObj) {
        return { error: 'Auth error: failed to get token. Make sure the Qwen tab is logged in.', chatId };
    }
    if (tokenObj.token) authToken = tokenObj.token;

    const reasoningEffort = options.reasoningEffort ?? null;
    const reasoningMode = options.reasoningMode ?? modeForReasoningEffort(reasoningEffort);
    if (reasoningMode) {
        logInfo(`Reasoning mode: ${reasoningMode} (reasoning_effort: ${reasoningEffort || 'n/a'})`);
    } else if (reasoningEffort) {
        logWarn(`Unknown reasoning_effort "${reasoningEffort}"; keeping current feature_config`);
    }

    let chatAuthRetried = false;
    if (!chatId) {
        const newChatResult = await createChatV2(model, 'New chat', 0, chatType, tokenObj);
        if (newChatResult.error) return { error: 'Failed to create chat: ' + newChatResult.error, status: newChatResult.status, unauthorized: newChatResult.unauthorized };
        chatId = newChatResult.chatId;
        chatAuthRetried = Boolean(newChatResult.authRetried);
        logInfo(`Created new chat v2 with ID: ${chatId}`);
    }

    const validated = validateAndPrepareMessage(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, chatId };
    }
    const messageContent = validated.content;

    if (!model || model.trim() === '') {
        model = DEFAULT_MODEL;
    } else if (!isValidModel(model)) {
        logWarn(`Model "${model}" not found in available list. Using default model.`);
        model = DEFAULT_MODEL;
    }
    logInfo(`Using model: "${model}"`);
    if (chatType !== 't2t') {
        const typeLabels = { t2i: 'image', t2v: 'video' };
        logInfo(`Generation type: ${chatType} (${typeLabels[chatType] || chatType})${size ? `, size: ${size}` : ''}`);
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        if (!chatAuthRetried) await syncTokenFromPage(page, tokenObj);

        // Detect a captcha BEFORE firing the request. The old checkVerification()
        // blocked on stdin (which hangs under NON_INTERACTIVE) and only looked at
        // the page title, so slider/WAF captchas were missed entirely.
        const preflightSignal = await readCaptchaSignal(page);
        if (preflightSignal) {
            notifyCaptcha(preflightSignal);
            const notify = typeof options.onCaptcha === 'function' ? options.onCaptcha : onChunk;
            if (typeof notify === 'function') notify(CAPTCHA_NOTICE);
            const cleared = await waitForCaptchaClear(page);
            if (!cleared) return { error: CAPTCHA_NOTICE, verification: true, captcha: true, chatId };
            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        } else if (process.stdin.isTTY && await checkVerification(page)) {
            // Interactive mode only: a human may be mid-login on this tab.
            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        }

        if (!authToken) {
            logWarn('Token missing before sending request');
            authToken = await page.evaluate(() => localStorage.getItem('token'));
            if (!authToken) return { error: 'Auth token not found. Restart in visible mode required.', chatId };
            saveAuthToken(authToken);
        }

        logInfo('Sending request to API v2...');

        const validationTools = toolChoice === 'none'
            ? null
            : (Array.isArray(options.declaredTools) && options.declaredTools.length > 0
                ? options.declaredTools
                : (Array.isArray(tools) && tools.length > 0 ? tools : null));
        const allowedToolNames = validationTools ? toolNames(validationTools) : null;
        const requiredToolParams = allowedToolNames ? toolRequiredParams(validationTools) : null;
        const hasDeclaredTools = Boolean(allowedToolNames && allowedToolNames.size > 0);

        const payload = buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType, size, reasoningMode, hasDeclaredTools);
        logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        logDebug(`Sending message to chat ${chatId} with parent_id: ${parentId || 'null'}`);

        const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
        // Tool routes pass no client callback (they need the whole answer to
        // parse tool calls). Give them an internal sink so the request streams
        // through Node instead of waiting on one 5-minute page.evaluate.
        // Non-stream text requests are collected through Node as well.
        const collectOnly = typeof onChunk !== 'function' && (options.collectOnly === true || chatType === 't2t');
        const streamChunk = collectOnly ? () => {} : onChunk;
        // Suppress live reasoning only on the nudge retry (where _toolRetryDone is set),
        // not on the first attempt — otherwise the user loses thinking output entirely.
        const streamReasoning = (collectOnly && options._toolRetryDone) ? null : (options.onReasoning || null);
        const apiOptions = { allowedToolNames, onCaptcha: options.onCaptcha, collectOnly, signal: options.signal };
        let response = await executeApiRequest(page, apiUrl, payload, authToken, streamChunk, streamReasoning, apiOptions);

        // One nudge retry max per request when tools were declared and model broke tool call format (or toolChoice requires one).
        // Undeclared built-in native calls (e.g. web_search) do NOT trigger a nudge
        // retry when the model answered normally in text.
        const canNudgeRetry = collectOnly || typeof onChunk !== 'function';
        if (response.success && !response.isTask && allowedToolNames && !options._toolRetryDone) {
            const first = finalizeToolCallsInResponse(response, allowedToolNames, requiredToolParams);
            const retryDecision = shouldRetryToolCall({ merged: first.merged, dropped: first.textDropped, toolChoice });
            if (canNudgeRetry && retryDecision) {
                const names = Array.from(allowedToolNames).join(', ');
                const isSoft = retryDecision === 'soft';
                let nudge;
                if (isSoft) {
                    // Neutral nudge: include a preview of the previous draft (same parent_id
                    // means Qwen has no other way to know which example/snippet is referenced).
                    // Do NOT command "Use a tool NOW" — that would turn examples into commands.
                    const prevDraft = String(response.data?.choices?.[0]?.message?.content || '').trim();
                    const draftSection = prevDraft
                        ? `\n\n[Your previous draft response — not yet sent to the user]:\n${prevDraft.slice(0, 2000)}\n`
                        : '\n';
                    nudge = `${draftSection}\nIf you intended to call a tool, resend the response with the tool call JSON in a \`\`\`tool_call block on its own line. If this was only an example or explanation, reply normally without a tool call.`;
                } else {
                    const reason = first.textDropped.length > 0 ? ` Previous attempt was rejected: ${first.textDropped.join('; ')}.` : '';
                    nudge = `\n\nIMPORTANT: Use a tool call now.${reason} Respond ONLY with a valid \`\`\`tool_call JSON block using one of these tools: ${names}.`;
                }
                const retryMessage = `${messageContent}${nudge}`;
                const retrySystem = (!isSoft && systemMessage) ? `${systemMessage}${nudge}`.trim() : systemMessage;
                const retryPayload = buildPayloadV2(retryMessage, model, chatId, parentId, files, retrySystem, tools, toolChoice, chatType, size, reasoningMode, hasDeclaredTools);
                logWarn(`Tool call missing/broken; retrying once with ${isSoft ? 'soft' : 'hard'} nudge. dropped=${first.textDropped.join('; ') || 'none'}`);
                options = { ...options, _toolRetryDone: true };
                // Always suppress reasoning on nudge retry — the first attempt already streamed it.
                const retryStreamReasoning = null;
                const retryResponse = await executeApiRequest(page, apiUrl, retryPayload, authToken, streamChunk, retryStreamReasoning, apiOptions);
                if (retryResponse?.data) retryResponse.data._toolRetryDone = true;
                // Parse the retry — otherwise its tool call stays as text.
                const retryResult = finalizeToolCallsInResponse(retryResponse, allowedToolNames, requiredToolParams);

                // Fix C: for a soft-nudge retry, only adopt the new response if it produced
                // a real tool call. If the retry failed (network/500) or returned no tool call
                // (the model really was writing an explanation), keep the ORIGINAL response so
                // the client sees the full first answer rather than a one-liner like
                // "That was only an example." or a raw error message.
                if (isSoft) {
                    if (retryResponse.success && retryResult.merged.length > 0) {
                        // Retry produced a tool call — use it.
                        response = retryResponse;
                    } else {
                        // Retry produced no tool call or failed — restore original response.
                        logWarn('Soft-nudge retry produced no tool call; keeping original response.');
                        // first is already finalized into response; nothing to do.
                    }
                } else {
                    // Hard nudge: always adopt the retry response (caller expects a tool call).
                    response = retryResponse;
                }
            }
        } else if (response?.success && !response?.isTask && allowedToolNames) {
            finalizeToolCallsInResponse(response, allowedToolNames, requiredToolParams);
        }

        if (response.success && response.isTask) {
            logInfo('Response with task detected (video generation)');
            logRaw(JSON.stringify(response.data));

            const taskId = extractTaskId(response.data);
            if (!taskId) {
                logError('Task ID not found in response');
                pagePool.releasePage(page);
                page = null;
                return { error: 'Task ID not found in response', chatId, rawResponse: response.data };
            }

            logInfo(`Task ID: ${taskId}`);

            if (!waitForCompletion) {
                logInfo('Returning task_id for client-side polling');
                pagePool.releasePage(page);
                page = null;
                return {
                    id: taskId,
                    object: 'chat.completion.task',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    task_id: taskId,
                    chatId,
                    parentId: response.data.data?.parent_id || taskId,
                    status: 'processing',
                    message: 'Video generation task created. Use GET /api/tasks/status/:taskId for progress.'
                };
            }

            logInfo('Starting polling to get video...');
            const taskResult = await pollTaskStatus(taskId, page, authToken);

            pagePool.releasePage(page);
            page = null;

            if (taskResult.success && taskResult.status === 'completed') {
                logInfo('Video successfully generated');
                const videoUrl = extractVideoUrl(taskResult.data);
                return {
                    id: taskId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: videoUrl || JSON.stringify(taskResult.data) },
                        finish_reason: 'stop'
                    }],
                    usage: taskResult.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    response_id: taskId,
                    chatId,
                    parentId: taskId,
                    task_id: taskId,
                    video_url: videoUrl
                };
            }

            logError(`Failed to get video: ${taskResult.error}`);
            return { error: taskResult.error || 'Video generation failed', status: taskResult.status, chatId, task_id: taskId };
        }

        pagePool.releasePage(page);
        page = null;

        // Qwen may respond HTTP 200 with body {success:false, data:{code,details}}
        // (e.g. "Model not found") or WAF header {ret:["FAIL_..."]}.
        if (response.success && response.data) {
            const apiData = response.data;
            const wafBlocked = Array.isArray(apiData.ret) && typeof apiData.ret[0] === 'string' && apiData.ret[0].startsWith('FAIL_');
            if (apiData.success === false || wafBlocked) {
                const apiError = apiData.data || {};
                const errorMessage = apiError.details || apiError.code
                    || (wafBlocked ? `WAF: ${apiData.ret[0]}` : 'Qwen API returned error');
                logError(`Qwen API error: ${errorMessage}`);
                return { error: errorMessage, details: JSON.stringify(apiError || apiData).slice(0, 500), chatId };
            }
        }

        if (response.success) {
            logRaw(JSON.stringify(response.data));
            logInfo('Response received successfully');
            response.data.chatId = chatId;
            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();

            // Non-stream upstream responses may carry thinking in extra choices.
            if (response.data.choices?.[0]?.message && !response.data.choices[0].message.reasoning_content) {
                const upstreamReasoning = reasoningFromCompletion(response.data);
                if (upstreamReasoning) response.data.choices[0].message.reasoning_content = upstreamReasoning;
            }

            // Fallback: if streaming callback was not invoked, send content as single chunk.
            if (typeof onChunk === 'function' && response.data.choices?.[0]?.message?.content && !response.hasStreamedChunks) {
                onChunk(response.data.choices[0].message.content);
            }

            return response.data;
        }

        return handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk, options, tools, toolChoice, systemMessage);
    } catch (error) {
        logError('Error sending message', error);
        const text = String(error);
        // A thrown CDP error used to be returned verbatim to the client. Route
        // it through the same bounded fresh-chat retry as an evaluate error.
        if (isProtocolTimeoutError({ error: text })) {
            return handleApiError(
                { success: false, error: text, protocolTimeout: true, chatId },
                tokenObj, message, model, chatId, parentId, files, retryCount,
                chatType, size, waitForCompletion, onChunk, options, tools, toolChoice, systemMessage
            );
        }
        return { error: text, chatId };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// --- Task response helpers -------------------------------------------------

function extractTaskId(data) {
    const firstMsg = data.data?.messages?.[0];
    if (firstMsg?.extra?.wanx?.task_id) return firstMsg.extra.wanx.task_id;
    return data.id || data.task_id || data.response_id || data.data?.message_id || null;
}

function findMediaUrl(value, extensions = ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp']) {
    if (!value) return null;
    if (typeof value === 'string') {
        const direct = value.match(/https?:\/\/[^\s"'<>]+/g)?.find(url => extensions.some(ext => url.toLowerCase().includes(ext)));
        return direct || null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
        return null;
    }
    if (typeof value === 'object') {
        const preferredKeys = ['video_url', 'image_url', 'url', 'content', 'result', 'output', 'data', 'message'];
        for (const key of preferredKeys) {
            if (key in value) {
                const found = findMediaUrl(value[key], extensions);
                if (found) return found;
            }
        }
        for (const item of Object.values(value)) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
    }
    return null;
}

export function extractMediaUrl(value, type = 'any') {
    const extensions = type === 'video'
        ? ['.mp4', '.mov', '.webm']
        : type === 'image'
            ? ['.png', '.jpg', '.jpeg', '.webp']
            : ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp'];
    return findMediaUrl(value, extensions);
}

function extractVideoUrl(taskData) {
    return extractMediaUrl(taskData, 'video');
}

export async function pollQwenTaskStatus(taskId, waitForCompletion = false) {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Browser is not initialized', task_id: taskId };

    const tokenObj = await resolveAuthToken(browserContext);
    if (!tokenObj?.token) return { error: 'Auth error: failed to get token', task_id: taskId };

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        const result = waitForCompletion
            ? await pollTaskStatus(taskId, page, tokenObj.token)
            : await pollTaskStatus(taskId, page, tokenObj.token, 1, 0);

        const mediaUrl = extractMediaUrl(result.data || result, 'video') || extractMediaUrl(result.data || result, 'image');
        return {
            task_id: taskId,
            success: result.success,
            status: result.status,
            error: result.error,
            video_url: extractMediaUrl(result.data || result, 'video'),
            image_url: extractMediaUrl(result.data || result, 'image'),
            media_url: mediaUrl,
            data: result.data
        };
    } finally {
        if (page) pagePool.releasePage(page);
    }
}

export async function clearPagePool() {
    await pagePool.clear();
}

export function getAuthToken() {
    return authToken;
}

// Recover from a 401 while creating a chat: wait for the rotated token
// in the live Qwen tab, or force a refresh by reloading the proxy-owned tab.
// Returns the token object to use for the retry, or null when nothing is left.
async function refreshTokenAfter401(browserContext, failedToken, tokenObj) {
    const fresh = await recoverBrowserToken(browserContext, failedToken || null);
    if (fresh) {
        authToken = fresh;
        saveAuthToken(fresh);
        logInfo('Refreshed browser token after chat-creation 401');
        return { ...(tokenObj || {}), id: 'browser', token: fresh, source: 'browser' };
    }
    return null;
}

// Switch the caller's token object to another account in place: sendMessage keeps
// this reference for error attribution. Every old field is dropped, so a previous
// `source: 'browser'` cannot stick to a stored account.
function adoptToken(target, next) {
    if (!target || target === next) return next;
    for (const key of Object.keys(target)) delete target[key];
    return Object.assign(target, next);
}

// --- createChatV2 ----------------------------------------------------------

export async function createChatV2(model = DEFAULT_MODEL, title = 'New chat', retryCount = 0, chatType = 't2t', tokenObj = null, skipPageTokenSync = false, authRetried = false) {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Browser is not initialized' };

    // Single-account mode: always use browser tab token.
    if (!tokenObj) tokenObj = await resolveAuthToken(browserContext);
    if (tokenObj?.token) {
        authToken = tokenObj.token;
        logInfo('Using browser tab token for chat creation');
    }

    if (!authToken) {
        logInfo('Getting auth token for chat creation...');
        authToken = await extractAuthToken(browserContext);
        if (!authToken) return { error: 'Failed to get auth token' };
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        // On an auth retry the token was just refreshed/switched; do not let a
        // stale token still sitting in the page overwrite it.
        if (!skipPageTokenSync) await syncTokenFromPage(page, tokenObj);
        const requestToken = authToken;

        const payload = { title, models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now() };
        const requestBody = { apiUrl: CREATE_CHAT_URL, payload, token: requestToken, headers: loadBaxiaHeaders() || null };

        const result = await page.evaluate(async (data) => {
            try {
                const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` };
                if (data.headers) {
                    for (const [k, v] of Object.entries(data.headers)) headers[k] = v;
                    headers['X-Request-Id'] = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
                    headers['Authorization'] = `Bearer ${data.token}`;
                }
                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(data.payload)
                });
                if (response.ok) return { success: true, data: await response.json() };
                return { success: false, status: response.status, errorBody: await response.text() };
            } catch (error) {
                return { success: false, error: error.toString() };
            }
        }, requestBody);

        pagePool.releasePage(page);
        page = null;

        if (result.success && result.data.success) {
            logInfo(`Chat created: ${result.data.data.id}`);
            return { success: true, chatId: result.data.data.id, requestId: result.data.request_id, authRetried };
        }

        if (isUnauthorizedResult(result)) {
            logWarn(`Chat creation unauthorized (401), attempt ${retryCount + 1}`);
            if (result.errorBody) logWarn(`401 response body: ${String(result.errorBody).slice(0, 300)}`);
            const unauthorizedError = { error: 'All tokens are invalid (401). Re-authentication required.', status: 401, unauthorized: true };
            if (retryCount >= MAX_RETRY_COUNT) {
                logError('Chat creation 401 retries exhausted.');
                return unauthorizedError;
            }
            const refreshed = await refreshTokenAfter401(browserContext, requestToken, tokenObj);
            if (!refreshed) {
                logError('Token expired and refresh failed.');
                return unauthorizedError;
            }
            // Keep the caller (sendMessage) on the same token we use to retry
            // so chat creation and message sending stay consistent.
            tokenObj = refreshed;
            logInfo(`Retrying chat creation with refreshed token (attempt ${retryCount + 2})`);
            return createChatV2(model, title, retryCount + 1, chatType, tokenObj, true, true);
        }

        const isTransient = result.status >= 500 && result.status < 600;
        if (isTransient && retryCount < MAX_RETRY_COUNT) {
            logWarn(`Chat creation: ${result.status}, retry ${retryCount + 1}/${MAX_RETRY_COUNT} after ${RETRY_DELAY}ms...`);
            await delay(RETRY_DELAY);
            return createChatV2(model, title, retryCount + 1, chatType, tokenObj);
        }

        const cleanError = isTransient
            ? `Qwen API unavailable (${result.status}). Please try again later.`
            : (result.errorBody || result.error || 'Unknown error');
        logError(`Error creating chat: ${result.status || 'unknown'} (attempt ${retryCount + 1})`);
        return { error: cleanError, ...(result.status ? { status: result.status } : {}) };
    } catch (error) {
        logError('Error creating chat', error);
        const text = String(error);
        // A frozen tab can also time out while creating the chat (seen at
        // 13:12 -> 13:17 in the log). Give it one bounded retry on a new page.
        if (isProtocolTimeoutError({ error: text }) && retryCount < MAX_RETRY_COUNT) {
            logWarn(`Chat creation protocol timeout; retrying (${retryCount + 1}/${MAX_RETRY_COUNT})`);
            await delay(RETRY_DELAY);
            return createChatV2(model, title, retryCount + 1, chatType, tokenObj);
        }
        const protocolTimeout = isProtocolTimeoutError({ error: text });
        return {
            error: protocolTimeout ? 'Qwen browser did not respond in time. Please retry shortly.' : text,
            protocolTimeout
        };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}


