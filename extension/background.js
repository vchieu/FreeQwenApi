// Observes Qwen's own chat-completions requests and forwards the exact token
// + Baxia headers to the local proxy. Observation only: every request is left
// untouched, and nothing is sent anywhere except the loopback endpoint.

const ENDPOINT = 'http://127.0.0.1:3264/api/session/sync';
const CHAT_URL_RE = /^https:\/\/chat\.qwen\.ai\/api\/v2\/chat\/completions/;
const ALARM = 'qwen-session-sync';
const PUSH_DEBOUNCE_MS = 1500;

let debounceTimer = null;
let lastSignature = '';
let lastResult = { status: 'idle' };

function schedulePush(force = false) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void pushToServer(force);
    }, PUSH_DEBOUNCE_MS);
}

async function getCapture() {
    const r = await chrome.storage.local.get('capture');
    return r?.capture || null;
}

async function setCapture(capture) {
    await chrome.storage.local.set({ capture });
}

function signature(capture) {
    if (!capture) return '';
    const h = capture.headers || {};
    return [capture.token, h['bx-umidtoken'] || '', h['bx-ua'] || '', capture.chatId || ''].join('|');
}

async function pushToServer(force = false) {
    const capture = await getCapture();
    if (!capture?.token || !capture?.headers || !capture?.chatId) {
        lastResult = { status: 'no-capture' };
        return lastResult;
    }
    const sig = signature(capture);
    if (!force && sig === lastSignature) {
        lastResult = { status: 'unchanged' };
        return lastResult;
    }
    try {
        const resp = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Qwen-Sync': '1' },
            body: JSON.stringify(capture)
        });
        const text = await resp.text();
        lastResult = { status: resp.ok ? 'ok' : 'error', httpStatus: resp.status, detail: text.slice(0, 300) };
        if (resp.ok) lastSignature = sig;
    } catch (error) {
        lastResult = { status: 'error', detail: String(error?.message || error) };
    }
    await chrome.storage.local.set({ lastResult });
    return lastResult;
}

// Capture the authorization token and WAF headers from a genuine UI request.
chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const headers = {};
        let token = '';
        for (const h of details.requestHeaders || []) {
            const name = h.name || '';
            const lower = name.toLowerCase();
            if (!h.value) continue;
            if (lower === 'authorization') {
                token = String(h.value).replace(/^Bearer\s+/i, '').trim();
                continue; // authorization is rebuilt by the proxy; never store it
            }
            headers[name] = String(h.value);
        }
        if (!token) return;
        let chatId = '';
        try {
            chatId = new URL(details.url).searchParams.get('chat_id') || '';
        } catch {
            // ignore
        }
        if (!chatId) return;
        void setCapture({ token, chatId, url: details.url, headers }).then(() => schedulePush(false));
    },
    { urls: ['https://chat.qwen.ai/api/v2/chat/completions*'] },
    ['requestHeaders', 'extraHeaders']
);

// Token reported by the content script (and periodic refresh) keeps the
// capture current even when no new UI message has been sent.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'qwen-token' && msg.token) {
        void (async () => {
            const capture = (await getCapture()) || {};
            if (capture.token === msg.token) return;
            await setCapture({
                ...capture,
                token: msg.token,
                url: capture.url || `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${capture.chatId || ''}`
            });
            // Only a token arrived; without WAF headers there is nothing to push.
            schedulePush(false);
        })();
    } else if (msg?.type === 'qwen-sync-now') {
        void pushToServer(true).then(sendResponse);
        return true;
    } else if (msg?.type === 'qwen-sync-status') {
        void (async () => {
            const capture = await getCapture();
            const status = await chrome.storage.local.get('lastResult');
            sendResponse({
                capture: capture ? { chatId: capture.chatId, capturedFrom: capture.url } : null,
                lastResult: status?.lastResult || lastResult
            });
        })();
        return true;
    }
});

async function refreshTokenFromTab() {
    try {
        const tabs = await chrome.tabs.query({ url: 'https://chat.qwen.ai/*' });
        for (const tab of tabs) {
            const r = await chrome.tabs.sendMessage(tab.id, { type: 'qwen-read-token' }).catch(() => null);
            if (r?.token) return r.token;
        }
    } catch {
        // ignore
    }
    return null;
}

async function startupSync() {
    const token = await refreshTokenFromTab();
    if (token) {
        const capture = (await getCapture()) || {};
        if (capture.token !== token) {
            await setCapture({
                ...capture,
                token,
                url: capture.url || `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${capture.chatId || ''}`
            });
        }
    }
    await pushToServer(true);
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(ALARM, { periodInMinutes: 10 });
    void startupSync();
});
chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(ALARM, { periodInMinutes: 10 });
    void startupSync();
});
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === ALARM) void startupSync();
});
