// Applies session material pushed from the logged-in Qwen tab (CDP observer or
// the optional Chrome extension). Token and Baxia/WAF headers come from the
// same real UI request, so they stay in sync.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logInfo, logWarn } from '../logger/index.js';

const SESSION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'session');
const BAXIA_FILE = path.join(SESSION_DIR, 'baxia.json');
const TOKENS_FILE = path.join(SESSION_DIR, 'tokens.json');

// loadBaxiaHeaders() in chat.js drops these itself; never persist them here so
// the on-disk session keeps only the WAF headers it actually replays.
const DROP_HEADERS = /^(cookie|content-length|host|authorization|accept-encoding|connection|x-request-id)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function writeJsonAtomic(file, value) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    try {
        fs.renameSync(tmp, file);
    } catch {
        // Some Windows filesystems refuse an atomic replace over an open file.
        fs.copyFileSync(tmp, file);
        fs.unlinkSync(tmp);
    }
}

function decodeId(token) {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).id;
    } catch {
        return null;
    }
}

function cleanHeaders(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    const seen = new Set();
    for (const [key, value] of Object.entries(raw)) {
        if (DROP_HEADERS.test(key) || value == null) continue;
        const text = String(value);
        if (!text || text.length > 16384 || /[\r\n\0]/.test(text)) continue;
        const norm = key.toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        out[key] = text;
    }
    return Object.keys(out).length ? out : null;
}

function validatePayload(body) {
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!JWT_RE.test(token) || token.length > 8192) {
        return { error: 'Missing or invalid token' };
    }

    const rawHeaders = body.headers;
    if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
        return { error: 'Missing headers object' };
    }
    const lookup = Object.fromEntries(
        Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v])
    );
    if (!lookup['bx-umidtoken'] || !lookup['bx-ua']) {
        return { error: 'Headers are missing Baxia WAF values' };
    }

    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    if (!UUID_RE.test(chatId)) return { error: 'Missing or invalid chatId' };

    const url = typeof body.url === 'string' && body.url.startsWith('https://chat.qwen.ai/')
        ? body.url.slice(0, 2048)
        : `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`;

    if (body.postData != null && (typeof body.postData !== 'string' || body.postData.length > 65536)) {
        return { error: 'Invalid postData' };
    }

    return {
        value: {
            token,
            chatId,
            url,
            headers: cleanHeaders(rawHeaders),
            postData: typeof body.postData === 'string' ? body.postData : ''
        }
    };
}

function updateTokenFile(token) {
    let tokens = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        if (Array.isArray(parsed)) tokens = parsed;
    } catch {
        // Create a minimal account entry if the file is missing or corrupt.
    }

    const accountId = decodeId(token);
    const idx = tokens.findIndex(t =>
        t?.token === token ||
        (accountId && decodeId(t?.token || '') === accountId)
    );
    const target = idx >= 0 ? idx : 0;
    const existing = tokens[target] || {};
    tokens[target] = {
        ...existing,
        id: existing.id || `acc_${Date.now()}`,
        token,
        invalid: false,
        resetAt: null
    };
    writeJsonAtomic(TOKENS_FILE, tokens);
    return tokens[target].id;
}

export function applySessionSync(body) {
    const { error, value } = validatePayload(body);
    if (error) return { error };

    if (!value.headers) return { error: 'No usable headers after sanitization' };

    writeJsonAtomic(BAXIA_FILE, {
        capturedAt: new Date().toISOString(),
        url: value.url,
        headers: value.headers,
        postData: value.postData
    });
    const accountId = updateTokenFile(value.token);

    const result = { ok: true, chatId: value.chatId, accountId, headers: Object.keys(value.headers).length };
    logInfo(`Session sync applied: chat ${value.chatId}, ${result.headers} headers, account ${accountId}`);
    return result;
}

export function getSessionSyncStatus() {
    try {
        const baxia = JSON.parse(fs.readFileSync(BAXIA_FILE, 'utf8'));
        const token = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))?.[0]?.token || '';
        const exp = token ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp : null;
        return {
            ok: true,
            capturedAt: baxia.capturedAt || null,
            chatId: baxia.url ? new URL(baxia.url).searchParams.get('chat_id') : null,
            tokenExp: exp ? new Date(exp * 1000).toISOString() : null,
            headerCount: Object.keys(baxia.headers || {}).length
        };
    } catch (error) {
        logWarn(`Failed to read session sync status: ${error.message}`);
        return { ok: false, error: 'Session files not available yet' };
    }
}
