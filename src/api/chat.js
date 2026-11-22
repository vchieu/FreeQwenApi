import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus, ensureBrowserConnection } from '../browser/browser.js';
import { checkAuthentication, checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken } from '../browser/session.js';
import { getAvailableToken, markRateLimited, removeInvalidToken, markValid, markValidForToken, decodeTokenInfo } from './tokenManager.js';
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
    parseToolCalls, mergeToolCalls, toolNames, toolRequiredParams
} from './toolCalls.js';
import crypto from 'crypto';
import {
    CHAT_API_URL, CREATE_CHAT_URL, CHAT_PAGE_URL, TASK_STATUS_URL,
    PAGE_TIMEOUT, RETRY_DELAY, PAGE_POOL_SIZE,
    DEFAULT_MODEL, MAX_RETRY_COUNT,
    TASK_POLL_MAX_ATTEMPTS, TASK_POLL_INTERVAL,
    RATE_LIMIT_HOURS
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '..', 'AvailableModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let authToken = null;
let availableModels = null;
let authKeys = null;
let browserTokenRateLimited = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

export const pagePool = {
    pages: [],
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
                await page.evaluate(() => document.readyState);
                return page;
            } catch (e) {
                logWarn(`Page from pool is stale (${e.message?.substring(0, 60)}), creating new`);
                if (page !== baseContext) {
                    try { await page.close(); } catch { /* already dead */ }
                }
            }
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
            if (page === baseContext) continue;
            try { await page.close(); } catch (e) {
                logError('Error closing page in pool', e);
            }
        }
        this.pages = [];
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
async function readTokenFromQwenTab(browserContext) {
    try {
        const base = getBrowserContext() || browserContext;
        const browser = (base && typeof base.browser === 'function') ? base.browser() : null;
        if (!browser || typeof browser.pages !== 'function') return null;

        const pooled = new Set(pagePool.pages);
        const candidates = (await browser.pages()).filter(page => {
            if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
            const url = page.url();
            if (!url.includes('chat.qwen.ai')) return false;
            if (page === base || pooled.has(page)) return false;
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
    const { exp } = decodeTokenInfo(token);
    return !exp || exp > Date.now() + skewMs;
}

// Qwen rotates the short-lived token in the tab. When we catch the old one
// just before rotation, wait briefly for the page to install the replacement
// instead of firing a request that is guaranteed to return 401.
async function waitForFreshToken(browserContext, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const token = await readTokenFromQwenTab(browserContext);
        if (token && tokenIsFresh(token)) return token;
        await delay(400);
    }
    return null;
}

async function resolveAuthToken(browserContext) {
    const tokenObj = await getAvailableToken();
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
        if (tokenObj?.id) markValid(tokenObj.id, browserToken);
        else markValidForToken(browserToken);
        logInfo(`Using fresh browser token${tokenObj ? ` for ${tokenObj.id}` : ''}`);
        return { ...(tokenObj || {}), id: tokenObj?.id || 'browser', token: browserToken, source: 'browser' };
    }

    if (tokenObj && tokenObj.token) {
        authToken = tokenObj.token;
        logInfo(`Using account: ${tokenObj.id}`);
        return tokenObj;
    }

    if (browserTokenRateLimited) {
        logWarn('Browser token is rate limited, skipping fallback');
        return null;
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

    return authToken ? { id: 'browser', token: authToken } : null;
}

function buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType = 't2t', size = null, reasoningMode = null) {
    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();

    const isVideo = chatType === 't2v';

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
        auto_search: true
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

        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
            return { success: true, isTask: false, data: parsed };
        }
    } catch {
        // Ignore parse errors here and return a generic failure below.
    }

    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
}

async function executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk, onReasoning = null, options = {}) {
    try {
        if (!token) return { success: false, error: 'Auth token not found' };
        if (typeof fetch !== 'function') return { success: false, error: 'Fetch API is unavailable' };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': '*/*'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        }

        if (payload.stream === false) {
            const jsonResponse = await response.json();
            if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
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
        let fullReasoning = '';
        let responseId = null;
        let usage = null;
        let finished = false;
        let streamError = null;
        let hasStreamedChunks = false;

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || !line.startsWith('data:')) continue;

                const jsonStr = line.substring(5).trim();
                if (!jsonStr) continue;
                if (jsonStr === '[DONE]') {
                    finished = true;
                    break;
                }

                try {
                    const chunk = JSON.parse(jsonStr);

                    if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                        streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }
                    if (chunk.error && !chunk.choices) {
                        streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }

                    if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                    if (chunk.response_id) responseId = chunk.response_id;

                    if (chunk.choices && chunk.choices[0]) {
                        const delta = chunk.choices[0].delta || chunk.choices[0].message;
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
            }
        }

        if (streamError) {
            return { success: false, ...streamError, hasStreamedChunks };
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
            data: resultData
        };
    } catch (error) {
        return { success: false, error: error.toString() };
    }
}

// Qwen's Aliyun WAF (Baxia) challenges requests that lack the bx-ua/bx-umidtoken
// headers generated by et_f.js in the browser. session/baxia.json stores a set
// captured from one real UI request; they live for the whole session.
const BAXIA_HEADERS_FILE = path.join(__dirname, '..', '..', 'session', 'baxia.json');

function loadBaxiaHeaders() {
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

// Qwen web tokens live ~15 minutes; the page keeps refreshing them. Take the
// freshest token straight from the tab before each request.
async function syncTokenFromPage(page, tokenObj = null) {
    try {
        const fresh = await readTokenFromQwenTab(getBrowserContext())
            || await page.evaluate(() => localStorage.getItem('token'));
        if (!fresh || fresh === authToken) return;
        authToken = fresh;
        saveAuthToken(fresh);
        if (tokenObj?.id) markValid(tokenObj.id, fresh);
        markValidForToken(fresh);
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
            logInfo(`Chat ${chatId} deleted from Qwen history`);
            return true;
        }
        logWarn(`Failed to delete chat ${chatId}: ${result.status || result.error}`);
        return false;
    } catch (e) {
        logWarn(`Failed to delete chat ${chatId}: ${e.message}`);
        return false;
    } finally {
        if (page) pagePool.releasePage(page);
    }
}

async function executeApiRequest(page, apiUrl, payload, token, onChunk = null, onReasoning = null, options = {}) {
    const baxiaHeaders = loadBaxiaHeaders();
    const allowedToolNames = options.allowedToolNames instanceof Set ? Array.from(options.allowedToolNames) : null;
    if (baxiaHeaders && payload?.stream !== false && typeof onChunk === 'function') {
        logInfo('Baxia headers found: request will go through browser (node-streaming skipped)');
    }
    if (!baxiaHeaders && payload?.stream !== false && typeof onChunk === 'function') {
        const streamedResponse = await executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk, onReasoning, options);

        // Qwen's Aliyun WAF blocks the browserless node-streaming fetch and returns a
        // non-SSE captcha page (errorBody = WAF html). Do NOT return that - fall through
        // to the browser (page.evaluate) path, which carries the real session and is not
        // challenged. Without this, streaming requests surface the captcha as the answer.
        const wafBlockedNodeStream =
            streamedResponse.success !== true &&
            /Unexpected non-SSE 200/i.test(String(streamedResponse.error || ''));

        const canReturnDirectly = !wafBlockedNodeStream && (
            streamedResponse.success ||
            Boolean(streamedResponse.status) ||
            Boolean(streamedResponse.errorBody) ||
            streamedResponse.hasStreamedChunks === true
        );

        if (canReturnDirectly) {
            return streamedResponse;
        }

        logWarn(`Node-streaming unavailable (${streamedResponse.error || 'unknown error'}), falling back to browser fetch.`);
    }

    const requestBody = { apiUrl, payload, token, headers: baxiaHeaders || null, allowedToolNames };

    logDebug(`Using token: ${token ? 'Session token' : 'No token'}`);
    logDebug(`API URL: ${apiUrl}`);

    return page.evaluate(async (data) => {
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
                    if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                        return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
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

                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue;
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr) continue;
                        try {
                            const chunk = JSON.parse(jsonStr);

                            if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                                streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }
                            if (chunk.error && !chunk.choices) {
                                streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }

                            if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                            if (chunk.choices && chunk.choices[0]) {
                                const choice = chunk.choices[0];
                                const delta = choice.delta || choice.message;
                                if (delta && delta.function_call) collectNative(delta.function_call);
                                if (delta && Array.isArray(delta.tool_calls)) {
                                    for (const tc of delta.tool_calls) {
                                        const fn = tc.function || tc;
                                        collectNative({ id: tc.id ?? tc.index, name: fn.name, arguments: fn.arguments });
                                    }
                                }
                                // Thinking text goes to reasoning_content only;
                                // answer phases go to content. Handles both
                                // thinking_summary and full thinking phases.
                                const { reasoning, content } = consumeThinking(delta);
                                fullReasoning += reasoning;
                                fullContent += content;
                                if (choice.finish_reason) finished = true;
                            }
                            if (chunk.usage) usage = chunk.usage;
                        } catch { /* ignore parse errors for individual chunks */ }
                    }
                }

                if (streamError) {
                    return { success: false, ...streamError };
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
                    data: resultData
                };
            }

            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        } catch (error) {
            return { success: false, error: error.toString() };
        }
    }, requestBody);
}

async function handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk = null, options = {}) {
    logRaw(JSON.stringify(response));
    logError(`Error getting response: ${response.error || response.statusText}`);
    if (response.errorBody) logDebug(`Error response body: ${response.errorBody}`);

    if (response.html && response.html.includes('Verification')) {
        setAuthenticationStatus(false);
        logInfo('Verification required, restarting browser in visible mode...');
        await pagePool.clear();
        authToken = null;
        await shutdownBrowser();
        await initBrowser(true);
        return { error: 'Verification required. Browser restarted in visible mode.', verification: true, chatId };
    }

    if (response.status === 401 || (response.errorBody && (response.errorBody.includes('Unauthorized') || response.errorBody.includes('Token has expired')))) {
        logWarn(`Token ${tokenObj?.id} is invalid (401). Removing and trying another.`);
        if (response.errorBody) logWarn(`401 response body: ${String(response.errorBody).slice(0, 300)}`);
        authToken = null;
        browserTokenRateLimited = false;
        const isBrowserToken = tokenObj?.source === 'browser' || tokenObj?.id === 'browser';
        if (tokenObj?.id && !isBrowserToken) {
            const { markInvalid } = await import('./tokenManager.js');
            markInvalid(tokenObj.id);
        }

        // A browser token can be rejected simply because Qwen rotated it a
        // second before our request. Do not burn the account in that case:
        // wait for the rotation and retry the SAME chat once.
        if (isBrowserToken && retryCount < MAX_RETRY_COUNT) {
            const fresh = await waitForFreshToken(getBrowserContext());
            if (fresh) {
                authToken = fresh;
                saveAuthToken(fresh);
                markValidForToken(fresh);
                logInfo('Retrying with freshly rotated browser token');
                return sendMessage(message, model, chatId, parentId, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1, onChunk, options);
            }
        }

        const { hasValidTokens } = await import('./tokenManager.js');
        if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
            // chatId/parentId are reset: when switching accounts the old chat
            // belongs to the previous token and under the new one "does not exist".
            return sendMessage(message, model, null, null, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1, onChunk, options);
        }
        logError('No valid tokens left or retries exhausted.');
        return { error: 'All tokens are invalid (401). Re-authentication required.', chatId };
    }

    if (response.status === 429 || (response.errorBody && response.errorBody.includes('RateLimited'))) {
        let hours = RATE_LIMIT_HOURS;
        try {
            const rateInfo = JSON.parse(response.errorBody);
            hours = Number(rateInfo.num) || RATE_LIMIT_HOURS;
        } catch { /* errorBody might not be valid JSON */ }

        if (tokenObj?.id === 'browser') {
            browserTokenRateLimited = true;
            logWarn(`Browser token reached rate limit. Pausing for ${hours}h.`);
        } else if (tokenObj?.id) {
            markRateLimited(tokenObj.id, hours);
            logWarn(`Token ${tokenObj.id} reached rate limit. Pausing for ${hours}h and trying another token...`);
        }

        authToken = null;
        const { hasValidTokens } = await import('./tokenManager.js');
        if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
            // chatId/parentId are reset: when switching accounts the old chat
            // belongs to the previous token and under the new one "does not exist".
            return sendMessage(message, model, null, null, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1, onChunk, options);
        }
        return { error: `All tokens are rate limited (${hours}h)`, chatId };
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

export async function sendMessage(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0, onChunk = null, options = {}) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Browser is not initialized', chatId };

    // Resolve account ONCE: with the same token create the chat and
    // send the message - otherwise round-robin picks different
    // accounts and Qwen returns "chat is not exist".
    const tokenObj = await resolveAuthToken(browserContext);
    if (!tokenObj) return { error: 'Auth error: failed to get token', chatId };

    const reasoningEffort = options.reasoningEffort ?? null;
    const reasoningMode = options.reasoningMode ?? modeForReasoningEffort(reasoningEffort);
    if (reasoningMode) {
        logInfo(`Reasoning mode: ${reasoningMode} (reasoning_effort: ${reasoningEffort || 'n/a'})`);
    } else if (reasoningEffort) {
        logWarn(`Unknown reasoning_effort "${reasoningEffort}"; keeping current feature_config`);
    }

    if (!chatId) {
        const newChatResult = await createChatV2(model, 'New chat', 0, chatType, tokenObj);
        if (newChatResult.error) return { error: 'Failed to create chat: ' + newChatResult.error };
        chatId = newChatResult.chatId;
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
        await syncTokenFromPage(page, tokenObj);

        const verificationNeeded = await checkVerification(page);
        if (verificationNeeded) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        }

        if (!authToken) {
            logWarn('Token missing before sending request');
            authToken = await page.evaluate(() => localStorage.getItem('token'));
            if (!authToken) return { error: 'Auth token not found. Restart in visible mode required.', chatId };
            saveAuthToken(authToken);
        }

        logInfo('Sending request to API v2...');

        const allowedToolNames = Array.isArray(tools) && tools.length > 0 ? toolNames(tools) : null;
        const requiredToolParams = allowedToolNames ? toolRequiredParams(tools) : null;

        const payload = buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType, size, reasoningMode);
        logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        logDebug(`Sending message to chat ${chatId} with parent_id: ${parentId || 'null'}`);

        const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
        let response = await executeApiRequest(page, apiUrl, payload, authToken, onChunk, options.onReasoning || null, { allowedToolNames });

        // One nudge retry max per request when tools were declared and model missed/broke tool call format.
        if (response.success && !response.isTask && allowedToolNames && !options._toolRetryDone) {
            const content = response?.data?.choices?.[0]?.message?.content || '';
            const nativeCalls = Array.isArray(response?.data?.native_tool_calls) ? response.data.native_tool_calls : [];
            const nativeDropped = Array.isArray(response?.data?.native_tool_dropped) ? response.data.native_tool_dropped : [];
            const parsed = parseToolCalls(content, allowedToolNames, requiredToolParams);
            const merged = mergeToolCalls(nativeCalls, parsed.calls);
            const dropped = [...nativeDropped, ...parsed.dropped];

            if (merged.length === 0) {
                const names = Array.from(allowedToolNames).join(', ');
                const reason = dropped.length > 0 ? ` Previous attempt was rejected: ${dropped.join('; ')}.` : '';
                const nudge = `\n\nIMPORTANT: Use a tool call now.${reason} Respond ONLY with a tool_call block using one of these tools: ${names}.`;
                const retryPayload = buildPayloadV2(messageContent, model, chatId, parentId, files, `${systemMessage || ''}${nudge}`.trim(), tools, toolChoice, chatType, size, reasoningMode);
                logWarn(`Tool call missing/broken; retrying once with nudge. dropped=${dropped.length}`);
                response = await executeApiRequest(page, apiUrl, retryPayload, authToken, onChunk, options.onReasoning || null, { allowedToolNames });
                if (response?.data) response.data._toolRetryDone = true;
            } else {
                // Keep merged native+text calls for route normalization
                response.data.tool_calls_normalized = merged;
                if (dropped.length > 0) response.data.tool_calls_dropped = dropped;
            }
        } else if (response?.success && !response?.isTask && allowedToolNames) {
            const content = response?.data?.choices?.[0]?.message?.content || '';
            const nativeCalls = Array.isArray(response?.data?.native_tool_calls) ? response.data.native_tool_calls : [];
            const parsed = parseToolCalls(content, allowedToolNames, requiredToolParams);
            const merged = mergeToolCalls(nativeCalls, parsed.calls);
            if (merged.length > 0) response.data.tool_calls_normalized = merged;
            const dropped = [...(response?.data?.native_tool_dropped || []), ...parsed.dropped];
            if (dropped.length > 0) response.data.tool_calls_dropped = dropped;
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

        return handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk, options);
    } catch (error) {
        logError('Error sending message', error);
        return { error: error.toString(), chatId };
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

// --- createChatV2 ----------------------------------------------------------

export async function createChatV2(model = DEFAULT_MODEL, title = 'New chat', retryCount = 0, chatType = 't2t', tokenObj = null) {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Browser is not initialized' };

    // tokenObj may come from sendMessage - then chat creation and sending
    // go under the SAME account (otherwise round-robin creates chat on one
    // account, and message is sent under another - "chat is not exist").
    if (!tokenObj) tokenObj = await getAvailableToken();
    if (tokenObj?.token) {
        authToken = tokenObj.token;
        logInfo(`Using account for chat creation: ${tokenObj.id}`);
    }

    if (!authToken) {
        logInfo('Getting auth token for chat creation...');
        authToken = await extractAuthToken(browserContext);
        if (!authToken) return { error: 'Failed to get auth token' };
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        await syncTokenFromPage(page, tokenObj);

        const payload = { title, models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now() };
        const requestBody = { apiUrl: CREATE_CHAT_URL, payload, token: authToken, headers: loadBaxiaHeaders() || null };

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
            return { success: true, chatId: result.data.data.id, requestId: result.data.request_id };
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
        return { error: cleanError };
    } catch (error) {
        logError('Error creating chat', error);
        return { error: error.toString() };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// --- testToken -------------------------------------------------------------

export async function testToken(token) {
    const browserContext = getBrowserContext();
    if (!browserContext) return 'ERROR';

    let page;
    let shouldClosePage = false;
    try {
        page = await getPage(browserContext);
        shouldClosePage = page !== browserContext;
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

        const requestBody = {
            apiUrl: CHAT_API_URL,
            token,
            payload: { chat_type: 't2t', messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }], model: DEFAULT_MODEL, stream: false }
        };

        const result = await page.evaluate(async (data) => {
            try {
                const res = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` },
                    body: JSON.stringify(data.payload)
                });
                return { ok: res.ok, status: res.status };
            } catch (e) {
                return { ok: false, status: 0, error: e.toString() };
            }
        }, requestBody);

        if (result.ok || result.status === 400) return 'OK';
        if (result.status === 401 || result.status === 403) return 'UNAUTHORIZED';
        if (result.status === 429) return 'RATELIMIT';
        return 'ERROR';
    } catch (e) {
        logError('testToken error', e);
        return 'ERROR';
    } finally {
        if (page) {
            try { if (shouldClosePage) await page.close(); } catch { }
        }
    }
}
