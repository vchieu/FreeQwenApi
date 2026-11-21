#!/usr/bin/env node
// One human-like UI message -> capture request headers (baxia) AND the full
// SSE response body, so we can compare exactly what Qwen sends.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const OUT = path.join(process.cwd(), 'session', 'ui-full-capture.json');
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const page = (await browser.pages()).find(p => p.url().includes('chat.qwen.ai'));
if (!page) throw new Error('No Qwen tab');

const cdp = await page.target().createCDPSession();
await cdp.send('Network.enable');
const pending = new Map();
const saved = [];

function flush(requestId) {
    const e = pending.get(requestId);
    if (!e || !e.url || !e.extra || e.body === undefined) return;
    const headers = {};
    for (const [k, v] of Object.entries({ ...e.headers, ...e.extra })) {
        if (/^(cookie|content-length|host|connection|:)/i.test(k)) continue;
        headers[k] = String(v);
    }
    saved.push({ url: e.url, method: e.method, requestBody: e.postData || null, headers, responseBody: e.body });
    fs.writeFileSync(OUT, JSON.stringify(saved, null, 2));
    console.log(`Saved ${saved.length} response(s) to ${OUT}`);
    pending.delete(requestId);
}

cdp.on('Network.requestWillBeSent', ev => {
    if (!/\/api\/v2\/(chat\/completions|chats\/new)/.test(ev.request.url)) return;
    const e = pending.get(ev.requestId) || {};
    Object.assign(e, { url: ev.request.url, method: ev.request.method, headers: ev.request.headers, postData: ev.request.postData });
    pending.set(ev.requestId, e);
});
cdp.on('Network.requestWillBeSentExtraInfo', ev => {
    const e = pending.get(ev.requestId) || {};
    e.extra = ev.headers;
    pending.set(ev.requestId, e);
});
cdp.on('Network.loadingFinished', async ev => {
    if (!pending.has(ev.requestId)) return;
    try {
        const r = await cdp.send('Network.getResponseBody', { requestId: ev.requestId });
        const e = pending.get(ev.requestId);
        e.body = r.body;
        pending.set(ev.requestId, e);
        flush(ev.requestId);
    } catch { /* ignore */ }
});

console.log('Listening on', page.url());
console.log('Waiting for one UI request (120s).');

setTimeout(() => {
    console.log(`Done. ${saved.length} captured.`);
    browser.disconnect();
    process.exit(0);
}, 120_000);
