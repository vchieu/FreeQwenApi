#!/usr/bin/env node
// Capture the Aliyun Baxia anti-bot headers that Qwen's web UI sends with
// /api/v2/chat/completions. The proxy replays them from the page context,
// because the WAF rejects the same request coming from plain Node.
//
// Usage:
//   1. Start Chrome with --remote-debugging-port=9222 and log in to chat.qwen.ai
//   2. QWEN_CDP_URL=http://127.0.0.1:9222 node scripts/core/capture-baxia.mjs
//   3. Send one message in the Qwen tab
//
// The captured headers are written to session/baxia.json (override with
// BAXIA_OUT=/path/to/baxia.json). They are bound to the browser profile and
// stay valid for the session; recapture after logout or a profile switch.

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const CDP_URL = process.env.QWEN_CDP_URL || 'http://127.0.0.1:9222';
const OUT = process.env.BAXIA_OUT || path.join(process.cwd(), 'session', 'baxia.json');
const TIMEOUT_MS = Number(process.env.BAXIA_TIMEOUT_MS) || 10 * 60 * 1000;
const TARGET = /\/api\/v2\/chat\/completions/;

// Keep exactly what loadBaxiaHeaders() replays; never persist cookies or tokens.
const KEEP = /^(bx-|sec-ch-|accept-language$|timezone$|version$|source$|x-request-id$)/i;
const DROP = /^(cookie|authorization|content-length|host|connection)$/i;

function filterHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (DROP.test(key)) continue;
        if (KEEP.test(key)) out[key] = String(value);
    }
    return out;
}

function save(headers, url, postData) {
    if (!headers['bx-ua'] && !headers['bx-umidtoken']) return false;

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({
        capturedAt: new Date().toISOString(),
        url,
        headers,
        // Kept for payload comparison only; loadBaxiaHeaders() reads .headers.
        postData: postData || null
    }, null, 2));
    return true;
}

const browser = await puppeteer.connect({ browserURL: CDP_URL });
const pages = await browser.pages();
let page = pages.find(p => p.url().includes('chat.qwen.ai'));

if (!page) {
    page = pages.find(p => p.url() === 'about:blank') || await browser.newPage();
    console.log('Opening chat.qwen.ai...');
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

const cdp = await page.target().createCDPSession();
await cdp.send('Network.enable');

const pending = new Map();

// CDP does not guarantee event order: requestWillBeSentExtraInfo often arrives
// before requestWillBeSent. Keep both halves and save once we have them.
function trySave(requestId) {
    const entry = pending.get(requestId);
    if (!entry || !entry.url || !entry.extra) return;

    const headers = filterHeaders({ ...entry.headers, ...entry.extra });
    if (!save(headers, entry.url, entry.postData)) {
        console.log('No bx-ua/bx-umidtoken in the request - the WAF likely let it through without a challenge.');
        return;
    }

    console.log(`Saved to ${OUT}`);
    console.log('Headers:', Object.keys(headers).sort().join(', '));
    process.exit(0);
}

cdp.on('Network.requestWillBeSent', event => {
    if (!TARGET.test(event.request.url)) return;
    const entry = pending.get(event.requestId) || {};
    entry.url = event.request.url;
    entry.headers = event.request.headers;
    entry.postData = event.request.postData;
    pending.set(event.requestId, entry);
    console.log('Caught a completions request, waiting for headers...');
    trySave(event.requestId);
});

cdp.on('Network.requestWillBeSentExtraInfo', event => {
    const entry = pending.get(event.requestId) || {};
    entry.extra = event.headers;
    pending.set(event.requestId, entry);
    trySave(event.requestId);
});

console.log(`Listening to tab network: ${page.url()}`);
console.log('Send one message in the Qwen window and wait for the completions request.');
console.log(`Timeout: ${Math.round(TIMEOUT_MS / 1000)} s.`);

setTimeout(() => {
    console.error('Timed out waiting for a /api/v2/chat/completions request.');
    process.exit(1);
}, TIMEOUT_MS);
