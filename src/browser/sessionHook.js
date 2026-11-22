// CDP-injected observer for the real Qwen UI. The proxy injects this into
// every Qwen tab automatically — no browser extension is needed. It watches
// the page's own chat-completions requests and pushes the token + Baxia
// headers to the local proxy. Requests are never modified or delayed.

import { logInfo, logWarn } from '../logger/index.js';

// Serialized into page context by Puppeteer: keep it self-contained.
export function qwenSessionSyncHook(endpoint) {
    if (window.__freeqwenSessionSync) return;
    window.__freeqwenSessionSync = true;

    let lastSignature = '';

    function normalizeHeaders(input) {
        const out = {};
        if (!input) return out;
        if (typeof Headers !== 'undefined' && input instanceof Headers) {
            input.forEach((value, key) => { out[key] = value; });
        } else if (Array.isArray(input)) {
            for (const pair of input) {
                if (Array.isArray(pair) && pair.length >= 2) out[pair[0]] = pair[1];
            }
        } else {
            for (const [key, value] of Object.entries(input)) out[key] = value;
        }
        return out;
    }

    function report(headers, requestUrl) {
        try {
            const url = String(requestUrl || '');
            if (!url.includes('/api/v2/chat/completions')) return;
            const raw = normalizeHeaders(headers);
            const lower = {};
            for (const [key, value] of Object.entries(raw)) lower[key.toLowerCase()] = value;
            if (!lower['bx-umidtoken'] || !lower['bx-ua']) return;

            const auth = lower.authorization || localStorage.getItem('token');
            const token = String(auth || '').replace(/^Bearer\s+/i, '');
            const chatId = new URL(url, location.href).searchParams.get('chat_id');
            if (!token || !chatId) return;

            const signature = `${token}|${lower['bx-umidtoken']}`;
            if (signature === lastSignature) return;
            lastSignature = signature;

            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Qwen-Sync': '1' },
                body: JSON.stringify({ token, chatId, url, headers: raw })
            }).catch(() => { /* the proxy keeps its last good session on failure */ });
        } catch {
            // Observation must never break the page's own request.
        }
    }

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
        window.fetch = function (input, init) {
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                report(init && init.headers, url);
            } catch { /* ignore */ }
            return originalFetch.apply(this, arguments);
        };
    }

    const xhrProto = XMLHttpRequest.prototype;
    const originalOpen = xhrProto.open;
    xhrProto.open = function (method, url) {
        this.__qwenSyncUrl = url;
        return originalOpen.apply(this, arguments);
    };
    const originalSetHeader = xhrProto.setRequestHeader;
    xhrProto.setRequestHeader = function (name, value) {
        try {
            this.__qwenSyncHeaders = this.__qwenSyncHeaders || {};
            this.__qwenSyncHeaders[name] = value;
        } catch { /* ignore */ }
        return originalSetHeader.apply(this, arguments);
    };
    const originalSend = xhrProto.send;
    xhrProto.send = function (body) {
        try { report(this.__qwenSyncHeaders, this.__qwenSyncUrl); } catch { /* ignore */ }
        return originalSend.apply(this, arguments);
    };
}

export async function installSessionHook(browser, endpoint) {
    const inject = async (page) => {
        try {
            if (!page || !page.url().includes('chat.qwen.ai')) return;
            await page.evaluateOnNewDocument(qwenSessionSyncHook, endpoint);
            await page.evaluate(qwenSessionSyncHook, endpoint);
        } catch (error) {
            logWarn(`Session hook injection failed: ${error.message}`);
        }
    };

    for (const page of await browser.pages()) await inject(page);
    browser.on('targetcreated', async (target) => {
        if (target.type() !== 'page') return;
        try { await inject(await target.page()); } catch { /* ignore */ }
    });
    logInfo('Session sync observer installed in Qwen tabs');
}
