#!/usr/bin/env node
// Diagnostic: capture the wire headers of completions requests issued from
// the proxy's automation tabs (not the human tab).
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const OUT = process.env.PROXY_TRACE_OUT || 'session/proxy-trace.json';
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const attached = new Set();
const found = [];

async function attach(page) {
    const id = page.target()._targetId;
    if (attached.has(id)) return;
    attached.add(id);
    try {
        const cdp = await page.target().createCDPSession();
        await cdp.send('Network.enable');
        const pending = new Map();
        const flush = (rid) => {
            const e = pending.get(rid);
            if (!e || !e.url || !e.extra) return;
            found.push({ url: e.url, method: e.method, headers: { ...e.headers, ...e.extra }, postData: e.postData });
            fs.writeFileSync(OUT, JSON.stringify(found, null, 2));
            console.log(`[wire] ${e.method} ${e.url}`);
            pending.delete(rid);
        };
        cdp.on('Network.requestWillBeSent', ev => {
            if (!/chat\/completions/.test(ev.request.url)) return;
            const e = pending.get(ev.requestId) || {};
            Object.assign(e, { url: ev.request.url, method: ev.request.method, headers: ev.request.headers, postData: ev.request.postData });
            pending.set(ev.requestId, e);
            flush(ev.requestId);
        });
        cdp.on('Network.requestWillBeSentExtraInfo', ev => {
            const e = pending.get(ev.requestId) || {};
            e.extra = ev.headers;
            pending.set(ev.requestId, e);
            flush(ev.requestId);
        });
    } catch { /* tab closed meanwhile */ }
}

console.log('Watching all Qwen tabs, 90s...');
const until = Date.now() + 90_000;
const timer = setInterval(async () => {
    for (const p of await browser.pages()) {
        if (p.url().includes('chat.qwen.ai')) await attach(p);
    }
}, 200);
setTimeout(() => { clearInterval(timer); console.log(`Saved ${found.length} requests to ${OUT}`); browser.disconnect(); process.exit(0); }, 90_000);
