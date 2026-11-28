import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { saveSession, saveAuthToken } from './session.js';
import { startManualAuthentication } from './auth.js';
import { clearPagePool, getAuthToken } from '../api/chat.js';
import fs from 'fs';
import path from 'path';
import { logInfo, logError, logWarn, logDebug } from '../logger/index.js';
import {
    CHAT_PAGE_URL, NAVIGATION_TIMEOUT, RETRY_DELAY,
    VIEWPORT_WIDTH, VIEWPORT_HEIGHT, USER_AGENT,
    PUPPETEER_PROTOCOL_TIMEOUT_MS,
    SESSION_DIR, PORT
} from '../config.js';
import { installSessionHook } from './sessionHook.js';

puppeteer.use(StealthPlugin());

let browserInstance = null;
let browserContext = null;
export let isAuthenticated = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function initBrowser(visibleMode = true, skipManualRestart = false) {
    if (browserInstance) return true;

    const cdpUrl = (process.env.QWEN_CDP_URL || '').trim();
    logInfo(cdpUrl
        ? `Browser initialization: connecting to Chrome via CDP (${cdpUrl})...`
        : 'Browser initialization with Puppeteer Stealth...');
    try {
        if (cdpUrl) {
            // Attach to YOUR already-running, logged-in Chrome (launch it with
            // --remote-debugging-port=PORT --user-data-dir=<dir>). Reuses a
            // human-trusted session, so qwen serves no captcha and the headless
            // CDP evaluate no longer hangs - no empty-browser login required.
            browserInstance = await puppeteer.connect({
                browserURL: cdpUrl,
                protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS,
                defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }
            });
        } else {
            browserInstance = await puppeteer.launch({
                headless: !visibleMode,
                slowMo: visibleMode ? 30 : 0,
                protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS,
                executablePath: process.env.CHROME_PATH || undefined,
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage', '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
                    '--start-maximized', '--disable-infobars',
                    '--disable-extensions', '--disable-gpu',
                    '--no-first-run', '--no-default-browser-check',
                    '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list'
                ],
                defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
                ignoreHTTPSErrors: true
            });
        }

        // In CDP mode open a fresh tab (don't hijack the user's current tab).
        const page = cdpUrl
            ? await browserInstance.newPage()
            : ((await browserInstance.pages())[0] || await browserInstance.newPage());

        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [{ 0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }, description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1, name: 'Chrome PDF Plugin' }]
            });
            Object.defineProperty(navigator, 'connection', {
                get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false })
            });
            if (!navigator.getBattery) {
                navigator.getBattery = () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 });
            }

            const originalAddEventListener = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (type, listener, options) {
                if (type === 'mousemove' || type === 'mousedown' || type === 'mouseup') {
                    const wrappedListener = function (event) { setTimeout(() => listener.call(this, event), Math.random() * 3); };
                    return originalAddEventListener.call(this, type, wrappedListener, options);
                }
                return originalAddEventListener.call(this, type, listener, options);
            };

            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function (type) {
                const context = this.getContext('2d');
                if (context) {
                    const imageData = context.getImageData(0, 0, this.width, this.height);
                    const data = imageData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        const noise = Math.floor(Math.random() * 5) - 2;
                        data[i] = Math.max(0, Math.min(255, data[i] + noise));
                        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
                        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
                    }
                    context.putImageData(imageData, 0, 0);
                }
                return originalToDataURL.apply(this, arguments);
            };
        });

        browserContext = page;
        if (cdpUrl) {
            await installSessionHook(browserInstance, `http://127.0.0.1:${process.env.PORT || PORT}/api/session/sync`);
        }
        logInfo('Browser initialized with maximum anti-detection');

        // CDP-connected Chrome is already a real, logged-in session - skip the
        // interactive empty-browser login/captcha flow.
        if (visibleMode && !cdpUrl) {
            await startManualAuthenticationPuppeteer(page, skipManualRestart);
        }
        // loadSessionPuppeteer removed - was dead code (always returned false)

        return true;
    } catch (error) {
        logError('Error initializing browser', error);
        return false;
    }
}

async function saveSessionPuppeteer(page) {
    try {
        const cookies = await page.cookies();
        const sessionDir = path.join(process.cwd(), SESSION_DIR);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        fs.writeFileSync(path.join(sessionDir, 'cookies.json'), JSON.stringify(cookies, null, 2));
        logInfo('Cookies saved for browser session');
        return 'browser';
    } catch (error) {
        logError('Error saving session', error);
        return null;
    }
}

async function startManualAuthenticationPuppeteer(page, skipManualRestart) {
    try {
        logInfo('Opening page for manual authentication...');
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT });
        await delay(5000);

        console.log('------------------------------------------------------');
        console.log('               MANUAL AUTHENTICATION REQUIRED');
        console.log('------------------------------------------------------');
        console.log('Please perform the following steps:');
        console.log('1. Log in to the system in the opened browser');
        console.log('2. IMPORTANT: Move your mouse naturally, do not rush');
        console.log('3. If a captcha slider appears - solve it slowly');
        console.log('4. Wait for the main page to fully load');
        console.log('5. After successful authentication, press ENTER in the console');
        console.log('------------------------------------------------------');
        console.log('After successful authentication, press ENTER to continue...');

        await new Promise((resolve) => {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.resume();
            process.stdin.setEncoding('utf8');
            const onData = (key) => {
                if (key === '\n' || key === '\r' || key.charCodeAt(0) === 13) {
                    process.stdin.pause();
                    process.stdin.removeListener('data', onData);
                    logInfo('Confirmation received, continuing...');
                    resolve();
                }
            };
            process.stdin.on('data', onData);
        });

        const cookies = await page.cookies();
        logInfo(`Saved ${cookies.length} cookies`);

        const token = await page.evaluate(() =>
            localStorage.getItem('token') || localStorage.getItem('auth_token') ||
            localStorage.getItem('access_token') || sessionStorage.getItem('token') ||
            sessionStorage.getItem('auth_token') || null
        );

        if (token) {
            logInfo('Token found and will be saved');
            saveAuthToken(token);
        } else {
            logWarn('Token not found in localStorage/sessionStorage');
            logInfo('Trying to extract token from cookies...');
            const tokenCookie = cookies.find(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('auth'));
            if (tokenCookie) {
                logInfo(`Token found in cookie: ${tokenCookie.name}`);
                saveAuthToken(tokenCookie.value);
            }
        }

        const accountId = await saveSessionPuppeteer(page);
        if (accountId) logInfo(`Session saved with ID: ${accountId}`);

        setAuthenticationStatus(true);
        logInfo('Authentication completed successfully');

        if (!skipManualRestart) await restartBrowserInHeadlessMode();
    } catch (error) {
        logError('Error during manual authentication', error);
        throw error;
    }
}

export async function restartBrowserInHeadlessMode() {
    logInfo('Restarting browser in headless mode...');
    const token = getAuthToken();
    if (token) { logDebug('Saving token...'); saveAuthToken(token); await delay(1000); }
    await shutdownBrowser();
    await delay(RETRY_DELAY);
    const success = await initBrowser(false);
    logInfo(success ? 'Browser restarted in headless mode' : 'Error restarting browser');
}

export async function shutdownBrowser() {
    try {
        try { await clearPagePool(); } catch (e) { logError('Error clearing page pool', e); }

        const cdpUrl = (process.env.QWEN_CDP_URL || '').trim();
        if (browserInstance && cdpUrl) {
            // In CDP mode browser.close() would shut down the user's Chrome -
            // so we only disconnect.
            try { browserInstance.disconnect(); } catch (e) { logError('Error disconnecting from Chrome', e); }
        } else if (browserInstance) {
            try {
                const pages = await browserInstance.pages();
                for (const page of pages) await page.close().catch(() => {});
                await browserInstance.close();
            } catch (e) { logError('Error closing browser', e); }
        }
        browserContext = null;
        browserInstance = null;
        logInfo('Browser closed');
    } catch (error) {
        logError('Error during browser shutdown', error);
    }
}

// Checks whether the CDP connection to Chrome is alive, and reconnects
// if needed (e.g. after a crash / browser restart).
export async function ensureBrowserConnection() {
    if (browserInstance && browserInstance.isConnected()) return true;

    logWarn('Connection to Chrome lost, reconnecting...');
    try { browserInstance?.disconnect?.(); } catch { /* already gone */ }
    browserInstance = null;
    browserContext = null;
    try { await clearPagePool(); } catch { /* pages are dead anyway */ }

    return await initBrowser(false, true);
}

export function getBrowserContext() { return browserContext; }
export function setAuthenticationStatus(status) { isAuthenticated = status; }
export function getAuthenticationStatus() { return isAuthenticated; }
