#!/usr/bin/env node
// A/B diagnostic: send UI-body vs proxy-body and UI-headers vs proxy-headers
// from the same human tab to the same (UI-created) chat id.
import fs from 'node:fs';
import puppeteer from 'puppeteer';

function lastProxyPayload() {
    const lines = fs.readFileSync('logs/raw-responses.log', 'utf8').split(/\r?\n/);
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('=== PAYLOAD V2 ===')) { start = i + 1; break; }
    }
    const buf = [];
    for (let i = start; i < lines.length; i++) {
        if (/\[debug\]: Sending message to chat/.test(lines[i])) break;
        buf.push(lines[i].replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[^\]]+\]:?\s*/, ''));
    }
    return JSON.parse(buf.join('\n'));
}

const uiReq = JSON.parse(fs.readFileSync('session/api-trace.json', 'utf8'))
    .find(r => /chat\/completions/.test(r.url));
const proxyBody = lastProxyPayload();
const baxia = JSON.parse(fs.readFileSync('session/baxia.json', 'utf8')).headers;

const uiHeaders = { ...uiReq.headers };
const proxyHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Accel-Buffering': 'no',
    'Authorization': uiHeaders['Authorization']
};
const seen = new Set();
for (const [k, v] of Object.entries(baxia)) {
    if (/^(cookie|content-length|host|authorization|accept-encoding|connection|x-request-id)$/i.test(k)) continue;
    const n = k.toLowerCase();
    if (seen.has(n)) continue;
    seen.add(n);
    proxyHeaders[k] = String(v);
}

const url = uiReq.url;
const cases = [
    ['UI body + UI headers', uiReq.postData, uiHeaders],
    ['PROXY body + UI headers', JSON.stringify(proxyBody), uiHeaders],
    ['UI body + PROXY headers', uiReq.postData, proxyHeaders]
];

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const page = (await browser.pages()).find(p => p.url().includes('chat.qwen.ai'));
for (const [name, body, headers] of cases) {
    const out = await page.evaluate(async (d) => {
        try {
            const r = await fetch(d.url, { method: 'POST', headers: d.headers, body: d.body });
            const t = await r.text();
            return { status: r.status, ok: t.includes('"choices"') || t.includes('data:'), head: t.slice(0, 260) };
        } catch (e) { return { error: String(e) }; }
    }, { url, body, headers });
    console.log(`\n=== ${name} ===\n${JSON.stringify(out, null, 2)}`);
}
browser.disconnect();
