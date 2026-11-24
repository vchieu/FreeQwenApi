#!/usr/bin/env node
// Capture the Qwen "attach image -> send message" network sequence, INCLUDING the direct
// browser -> Aliyun OSS upload (qwen-webui-prod.oss-accelerate.aliyuncs.com) that
// capture-api-trace.mjs misses (it only keeps URLs containing /api/).
//
//   1. Start Chrome with --remote-debugging-port=9222 and open chat.qwen.ai (same as before)
//   2. node scripts/inspect/capture-upload-trace.mjs
//   3. In the Qwen tab: attach/paste ONE image, type a short message, press Send, wait for reply.
//      The script stops by itself ~4s after the completion request finishes.
//
// Output: session/upload-trace.json  (+ a timeline printed to the console)
//
// SECRETS ARE REDACTED BY DEFAULT, so the JSON is safe to paste/share:
//   - headers: Authorization -> "Bearer <redacted len=N>", Cookie -> cookie NAMES only,
//     x-oss-security-token / bx-* -> "<redacted|opaque len=N>"; header NAMES are always kept
//     (that is what matters when re-creating the requests).
//   - OSS Authorization keeps scheme + Credential scope + AdditionalHeaders (tells which
//     signature version is used) but masks the access key id and the signature.
//   - URLs / JSON: x-oss-security-token, x-oss-signature, access_key_secret, security_token,
//     access_key_id, ... are masked; long strings and message "content" are truncated.
//   - upload bytes are never stored (only size).
// API_TRACE_RAW=1 disables redaction (do NOT share that file).
//
// Env: QWEN_CDP_URL (http://127.0.0.1:9222)   API_TRACE_OUT (session/upload-trace.json)
//      API_TRACE_PAGE (tab URL substring, chat.qwen.ai)
//      API_TRACE_HOSTS (regex of hosts to keep, "qwen\.ai|aliyuncs\.com"; use "." for all hosts)
//      API_TRACE_SKIP (regex of hosts to drop, "^aplus\." = analytics pings; use "^$" to keep them)
//      API_TRACE_MS (max duration, 180000)   API_TRACE_STOP_AFTER_COMPLETION=0 (keep recording)
//      API_TRACE_RAW=1
//      API_TRACE_LIGHT=1  (no post-data/body capture; only metadata + timing - to rule out overhead)
//
// "Is the capture slowing the upload?"  Measured: attaching this script adds ~0-60 ms to a
// 90 MB upload on loopback (Blob/ArrayBuffer, fetch/XHR), i.e. nothing next to real network time.
// To see WHERE a slow upload spends its time, every request records Chrome's own timing
// breakdown (queued / dns / connect / ssl / send / wait), protocol, connection reuse and server IP,
// and the console prints a "slow requests" section (>= 2 s) plus an OSS upload summary.

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const CDP_URL = process.env.QWEN_CDP_URL || 'http://127.0.0.1:9222';
const OUT = process.env.API_TRACE_OUT || path.join(process.cwd(), 'session', 'upload-trace.json');
const MAX_MS = Number(process.env.API_TRACE_MS) || 180_000;
const PAGE_MATCH = process.env.API_TRACE_PAGE || 'chat.qwen.ai';
const HOSTS = new RegExp(process.env.API_TRACE_HOSTS || 'qwen\\.ai|aliyuncs\\.com', 'i');
const SKIP = new RegExp(process.env.API_TRACE_SKIP || '^aplus\\.', 'i');
const RAW = process.env.API_TRACE_RAW === '1';
const STOP_AFTER_COMPLETION = process.env.API_TRACE_STOP_AFTER_COMPLETION !== '0';
const KEEP_TYPES = new Set(['XHR', 'Fetch', 'Preflight', 'Ping', 'Other']);
const BODY_CAP = 20_000;
const LIGHT = process.env.API_TRACE_LIGHT === '1';
const SLOW_MS = Number(process.env.API_TRACE_SLOW_MS) || 2000;

// ------------------------------------------------------------------ redaction ----
const len = v => String(v).length;
const SECRET_KEY = /(secret|security_?token|access_?key_?id|access_?token|authorization|password|cookie|api_?key)/i;

function redactUrls(s) {
    return String(s)
        .replace(/(x-oss-credential=)[^%&\s/"']+/gi, '$1<ak>')
        .replace(/(x-oss-security-token|x-oss-signature|security-?token|signature|access_token|token)=([^&\s"']+)/gi,
            '$1=<redacted>');
}

function maskAuthorization(v) {
    let m = /^(OSS4-HMAC-SHA256\s+)(.*)$/i.exec(v);
    if (m) {
        return m[1] + m[2]
            .replace(/(Credential=)[^/,]+/i, '$1<ak>')
            .replace(/(Signature=)[0-9a-fA-F]+/i, '$1<redacted>');
    }
    m = /^(OSS\s+)([^:]+):(.+)$/.exec(v);
    if (m) return `${m[1]}<ak>:<redacted>`;
    m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(v);
    if (m) return `${m[1]} <redacted len=${len(m[2])}>`;
    return `<redacted len=${len(v)}>`;
}

function maskHeader(name, value) {
    const n = name.toLowerCase();
    const v = String(value);
    if (RAW) return v;
    if (n === 'authorization' || n === 'proxy-authorization') return maskAuthorization(v);
    if (n === 'cookie') return v.split(/;\s*/).map(c => c.split('=')[0] + '=<..>').join('; ');
    if (n === 'set-cookie') return v.split('\n').map(c => c.split('=')[0] + '=<..>').join(' | ');
    if (/^(x-oss-security-token|x-acs-security-token|x-csrf-token|x-xsrf-token)$/.test(n)) {
        return `<redacted len=${len(v)}>`;
    }
    if (/^bx-/.test(n) || /secret|signature/.test(n)) return `<opaque len=${len(v)}>`;
    return redactUrls(v).slice(0, 300);
}

function maskHeaders(h) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = maskHeader(k, v);
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function redactJson(v, key = '') {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
        if (SECRET_KEY.test(key)) return `<redacted len=${v.length}>`;
        const s = redactUrls(v);
        const lim = key === 'content' ? 120 : (/^https?:/i.test(s) ? 1500 : 400);
        return s.length > lim ? `${s.slice(0, lim)}…(len=${v.length})` : s;
    }
    if (Array.isArray(v)) return v.map(x => redactJson(x, key));
    if (typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactJson(x, k)]));
    }
    return v;
}

function maskBody(text) {
    if (text == null) return null;
    if (RAW) return text;
    try {
        return redactJson(JSON.parse(text));
    } catch {
        const s = redactUrls(text);
        return s.length > 800 ? `${s.slice(0, 800)}…(len=${text.length})` : s;
    }
}

// ------------------------------------------------------------------- capture ----
const browser = await puppeteer.connect({ browserURL: CDP_URL });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes(PAGE_MATCH)) || pages[0];
if (!page) throw new Error('No tab found');
console.log(`Listening on: ${page.url()}`);
if (RAW) console.log('!! API_TRACE_RAW=1: output is NOT redacted - do not share it.');

const cdp = await page.target().createCDPSession();
await cdp.send('Network.enable', LIGHT ? {} : { maxPostDataSize: 65536 });

const reqs = new Map();
const work = new Set();
let t0 = null;
let stopTimer = null;
const get = id => {
    if (!reqs.has(id)) reqs.set(id, { id });
    return reqs.get(id);
};
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const relevant = e => !!e.url && KEEP_TYPES.has(e.type) && HOSTS.test(hostOf(e.url)) && !SKIP.test(hostOf(e.url));
const isCompletion = e => /\/chat\/completions/.test(e.url || '') && e.method === 'POST';
const track = p => { work.add(p); p.finally(() => work.delete(p)); };

cdp.on('Network.requestWillBeSent', ev => {
    const e = get(ev.requestId);
    e.url = ev.request.url;
    e.method = ev.request.method;
    e.type = ev.type;
    e.headers = ev.request.headers;
    e.postData = ev.request.postData ?? e.postData;
    e.hasPostData = !!ev.request.hasPostData || !!ev.request.postData;
    e.t = ev.timestamp;
    e.wall = ev.wallTime;
    if (t0 === null) t0 = ev.timestamp;
    if (relevant(e)) console.log(`>> ${e.method} ${hostOf(e.url)}${new URL(e.url).pathname} (${e.type})`);
});
cdp.on('Network.requestWillBeSentExtraInfo', ev => { get(ev.requestId).extra = ev.headers; });
cdp.on('Network.responseReceived', ev => {
    const e = get(ev.requestId);
    e.status = ev.response.status;
    e.statusText = ev.response.statusText;
    e.mime = ev.response.mimeType;
    e.respHeaders = ev.response.headers;
    e.remote = ev.response.remoteIPAddress;
    e.protocol = ev.response.protocol;
    e.reused = ev.response.connectionReused;
    e.timing = ev.response.timing;
});
cdp.on('Network.responseReceivedExtraInfo', ev => {
    const e = get(ev.requestId);
    e.respExtra = ev.headers;
    if (e.status == null) e.status = ev.statusCode;
});
cdp.on('Network.loadingFailed', ev => {
    const e = get(ev.requestId);
    e.failed = ev.errorText + (ev.blockedReason ? ` (${ev.blockedReason})` : '') +
        (ev.corsErrorStatus ? ` cors=${ev.corsErrorStatus.corsError}` : '');
    e.tEnd = ev.timestamp;
    if (STOP_AFTER_COMPLETION && isCompletion(e)) scheduleStop();
});
cdp.on('Network.loadingFinished', ev => {
    const e = get(ev.requestId);
    e.tEnd = ev.timestamp;
    e.bytes = ev.encodedDataLength;
    if (!relevant(e)) return;
    if (isCompletion(e)) {
        if (STOP_AFTER_COMPLETION) scheduleStop();
        return;
    }
    if (LIGHT) return;
    track((async () => {
        try {
            if (e.hasPostData && e.postData == null &&
                /json|text/i.test(e.headers?.['Content-Type'] || e.headers?.['content-type'] || '')) {
                e.postData = (await cdp.send('Network.getRequestPostData', { requestId: e.id })).postData;
            }
        } catch { /* binary / evicted */ }
        try {
            if (/json|text|xml/i.test(e.mime || '') && !/event-stream/i.test(e.mime || '')) {
                const r = await cdp.send('Network.getResponseBody', { requestId: e.id });
                e.body = r.base64Encoded ? `<base64 ${r.body.length} chars>` : r.body.slice(0, BODY_CAP);
            }
        } catch { /* no body */ }
    })());
});

function scheduleStop() {
    if (stopTimer) return;
    console.log('completion finished -> stopping in 4s (API_TRACE_STOP_AFTER_COMPLETION=0 to keep going)');
    stopTimer = setTimeout(finish, 4000);
}

// Chrome timing (ms relative to timing.requestTime; -1 = phase not used, e.g. reused connection).
function phases(e) {
    const T = e.timing;
    if (!T) return null;
    const d = (a, b) => (T[a] >= 0 && T[b] >= 0 ? Math.round(T[b] - T[a]) : null);
    return {
        // JS issued the request -> network actually started: includes the CORS preflight and
        // Chrome's per-host connection limit
        queued_ms: e.t != null && T.requestTime ? Math.round((T.requestTime - e.t) * 1000) : null,
        dns_ms: d('dnsStart', 'dnsEnd'),
        connect_ms: d('connectStart', 'connectEnd'),   // includes ssl_ms
        ssl_ms: d('sslStart', 'sslEnd'),
        send_ms: d('sendStart', 'sendEnd'),            // body upload
        wait_ms: d('sendEnd', 'receiveHeadersEnd'),    // server think time (TTFB)
        headers_at_ms: T.receiveHeadersEnd >= 0 ? Math.round(T.receiveHeadersEnd) : null,
    };
}

function snapshot() {
    const rel = x => (x == null || t0 == null ? null : Math.round((x - t0) * 1000));
    return [...reqs.values()].filter(relevant).sort((a, b) => a.t - b.t).map(e => {
        const headers = { ...(e.headers || {}), ...(e.extra || {}) };
        const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-length');
        return {
            t_ms: rel(e.t),
            dur_ms: e.tEnd != null && e.t != null ? Math.round((e.tEnd - e.t) * 1000) : null,
            method: e.method,
            url: RAW ? e.url : redactUrls(e.url),
            type: e.type,
            status: e.status ?? null,
            protocol: e.protocol || null,
            connection_reused: e.reused ?? null,
            remote_ip: e.remote || null,
            timing: phases(e),
            request_bytes: ct ? Number(ct[1]) || null : null,
            failed: e.failed || null,
            request_headers: maskHeaders(headers),
            request_body: e.postData != null ? maskBody(e.postData)
                : (e.hasPostData ? `<binary/omitted${ct ? `, content-length=${ct[1]}` : ''}>` : null),
            response_headers: maskHeaders({ ...(e.respHeaders || {}), ...(e.respExtra || {}) }),
            response_body: e.body != null ? maskBody(e.body)
                : (isCompletion(e) ? '<SSE stream not captured>' : null),
        };
    });
}

function write() {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(snapshot(), null, 2));
}

let finished = false;
async function finish() {
    if (finished) return;
    finished = true;
    const until = Date.now() + 3000;
    while (work.size && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    write();
    const snap = snapshot();
    console.log('\n=== timeline ===');
    const shownHdr = new Set();
    for (const s of snap) {
        const u = new URL(s.url.replace(/<[^>]*>/g, 'x'));
        console.log(`+${(s.t_ms / 1000).toFixed(2).padStart(6)}s ${String(s.method).padEnd(7)} ` +
            `${u.hostname}${u.pathname} -> ${s.status == null && s.failed ? 'FAILED ' + s.failed : s.status + (s.failed ? ' [' + s.failed + ' after response]' : '')}` +
            `${s.dur_ms != null ? ` (${s.dur_ms}ms)` : ''}`);
        const kind = /getstsToken/.test(u.href) ? 'sts' : /chat\/completions/.test(u.href) ? 'completion'
            : /aliyuncs\.com/.test(u.hostname) && s.method !== 'OPTIONS' ? 'oss' : '';
        if (kind && !shownHdr.has(kind)) {
            shownHdr.add(kind);
            console.log(`          headers: ${Object.keys(s.request_headers).join(', ')}`);
        }
    }
    const slow = snap.filter(s => (s.dur_ms ?? 0) >= SLOW_MS && !/chat\/completions/.test(s.url));
    if (slow.length) {
        console.log(`\n=== slow requests (>= ${SLOW_MS} ms, completions excluded) ===`);
        for (const s of slow) {
            const t = s.timing || {};
            const f = (k, l) => (t[k] != null ? `${l}=${t[k]}ms ` : '');
            const secs = Math.max(0.001, (s.dur_ms - (t.queued_ms || 0)) / 1000);
            const bw = s.request_bytes ? ` ~${Math.round(s.request_bytes / 1024 / secs)} KB/s` : '';
            const u = new URL(s.url.replace(/<[^>]*>/g, 'x'));
            console.log(`  ${s.method} ${u.hostname}${u.pathname.slice(0, 40)}${u.search.slice(0, 30)}: total=${s.dur_ms}ms ` +
                `${f('queued_ms', 'queued')}${f('dns_ms', 'dns')}${f('connect_ms', 'connect')}${f('ssl_ms', 'ssl')}` +
                `${f('send_ms', 'send')}${f('wait_ms', 'wait')}[${s.protocol || '?'}, reused=${s.connection_reused}, ${s.remote_ip || '?'}]${bw}`);
        }
        console.log('  queued = JS issued the request -> network started (CORS preflight + connection limits);' +
            ' dns/connect/ssl = cold connection;\n  send = body upload; wait = server time to first byte');
    }
    const oss = snap.filter(s => /aliyuncs\.com/.test(s.url) && s.method !== 'OPTIONS');
    if (oss.length) {
        const t1 = Math.min(...oss.map(s => s.t_ms));
        const t2 = Math.max(...oss.map(s => s.t_ms + (s.dur_ms || 0)));
        const bytes = oss.reduce((a, s) => a + (/^(PUT|POST)$/.test(s.method) ? s.request_bytes || 0 : 0), 0);
        const parts = oss.filter(s => /partNumber=/.test(s.url)).length;
        console.log(`\n=== OSS upload ===\n  ${oss.length} requests${parts ? ` (multipart: ${parts} parts)` : ' (single PUT)'}, ` +
            `${(bytes / 1048576).toFixed(2)} MB in ${((t2 - t1) / 1000).toFixed(1)}s wall ` +
            `(~${Math.round(bytes / 1024 / Math.max(0.001, (t2 - t1) / 1000))} KB/s effective)`);
    }
    console.log(`\nSaved ${snap.length} requests to ${OUT}${RAW ? ' (RAW, contains secrets!)' : ' (redacted)'}`);
    try { await browser.disconnect(); } catch { /* ignore */ }
    process.exit(0);
}

process.on('SIGINT', finish);
setTimeout(finish, MAX_MS);
console.log(`Recording up to ${MAX_MS / 1000}s. Attach ONE image, type a message, press Send. (Ctrl+C = stop & save)`);
