#!/usr/bin/env node
// Diagnostic: replay a captured UI completions request verbatim from the
// same Qwen tab, to isolate whether replay-in-page works at all.
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const trace = JSON.parse(fs.readFileSync('session/api-trace.json', 'utf8'));
const req = trace.find(r => /chat\/completions/.test(r.url));
if (!req) throw new Error('No completions request in api-trace.json');

const headers = {};
for (const [k, v] of Object.entries(req.headers)) {
    if (/^(cookie|content-length|host|connection|:)/i.test(k)) continue;
    headers[k] = String(v);
}

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const page = (await browser.pages()).find(p => p.url().includes('chat.qwen.ai'));
if (!page) throw new Error('No Qwen tab');
console.log('Tab:', page.url());
console.log('Replaying:', req.url);

const result = await page.evaluate(async (data) => {
    try {
        const res = await fetch(data.url, {
            method: 'POST',
            headers: data.headers,
            body: data.body
        });
        const text = await res.text();
        return { status: res.status, body: text.slice(0, 1500) };
    } catch (e) {
        return { error: String(e) };
    }
}, { url: req.url, headers, body: req.postData });

console.log(JSON.stringify(result, null, 2));
browser.disconnect();
