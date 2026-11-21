#!/usr/bin/env node
// Capture every Qwen API request from the real UI tab for payload comparison.
//
//   node scripts/inspect/capture-api-trace.mjs
//   -> click "New chat", then send one message in that tab
//
// Writes session/api-trace.json. Unlike capture-baxia.mjs this does not exit
// on the first completion, so the whole new-chat sequence is recorded.

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const CDP_URL = process.env.QWEN_CDP_URL || 'http://127.0.0.1:9222';
const OUT = process.env.API_TRACE_OUT || path.join(process.cwd(), 'session', 'api-trace.json');
const DURATION_MS = Number(process.env.API_TRACE_MS) || 120_000;

const browser = await puppeteer.connect({ browserURL: CDP_URL });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('chat.qwen.ai')) || pages[0];
if (!page) throw new Error('No Qwen tab found');

console.log(`Listening on: ${page.url()}`);
const cdp = await page.target().createCDPSession();
await cdp.send('Network.enable');

const pending = new Map();
const captured = [];

function flush(id) {
    const e = pending.get(id);
    if (!e || !e.url || !e.extra) return;
    captured.push({
        method: e.method,
        url: e.url,
        postData: e.postData || null,
        headers: e.headers || {},
        extraHeaders: e.extra || {}
    });
    fs.writeFileSync(OUT, JSON.stringify(captured, null, 2));
    console.log(`[${captured.length}] ${e.method} ${e.url.replace('https://chat.qwen.ai', '')}`);
    pending.delete(id);
}

cdp.on('Network.requestWillBeSent', ev => {
    if (!/\/api\//.test(ev.request.url)) return;
    const e = pending.get(ev.requestId) || {};
    e.url = ev.request.url;
    e.method = ev.request.method;
    e.headers = ev.request.headers;
    e.postData = ev.request.postData;
    pending.set(ev.requestId, e);
    flush(ev.requestId);
});

cdp.on('Network.requestWillBeSentExtraInfo', ev => {
    const e = pending.get(ev.requestId) || {};
    e.extra = ev.headers;
    pending.set(ev.requestId, e);
    flush(ev.requestId);
});

console.log(`Recording ${DURATION_MS / 1000}s. Click "New chat", then send one message.`);
setTimeout(() => {
    console.log(`Saved ${captured.length} requests to ${OUT}`);
    browser.disconnect();
    process.exit(0);
}, DURATION_MS);
