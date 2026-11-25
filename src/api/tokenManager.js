import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from '../logger/index.js';
import { SESSION_DIR, ACCOUNTS_DIR, RATE_LIMIT_HOURS } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_PATH = path.resolve(__dirname, '..', '..', SESSION_DIR);
const ACCOUNTS_PATH = path.join(SESSION_PATH, ACCOUNTS_DIR);
const TOKENS_FILE = path.join(SESSION_PATH, 'tokens.json');

let pointer = 0;

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_PATH)) fs.mkdirSync(ACCOUNTS_PATH, { recursive: true });
}

export function loadTokens() {
    ensureSessionDir();
    if (!fs.existsSync(TOKENS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    } catch (e) {
        logError('TokenManager: error reading tokens.json', e);
        return [];
    }
}

export function saveTokens(tokens) {
    ensureSessionDir();
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    } catch (e) {
        logError('TokenManager: error saving tokens.json', e);
    }
}

export async function getAvailableToken() {
    const tokens = loadTokens();
    const now = Date.now();
    // Qwen access tokens rotate every ~15 minutes. A JWT that is about to
    // expire would produce a 401 mid-request, so skip it and let the caller
    // pick up a fresh one from the browser tab.
    const valid = tokens.filter(t => {
        if (t.invalid) return false;
        if (t.resetAt && new Date(t.resetAt).getTime() > now) return false;
        const { exp } = decodeTokenInfo(t.token);
        return !exp || exp > now + 30_000;
    });
    if (!valid.length) return null;
    const token = valid[pointer % valid.length];
    pointer = (pointer + 1) % valid.length;
    return token;
}

export function hasValidTokens() {
    const tokens = loadTokens();
    const now = Date.now();
    return tokens.some(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);
}

export function markRateLimited(id, hours = RATE_LIMIT_HOURS) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        tokens[idx].resetAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        saveTokens(tokens);
    }
}

export function removeToken(id) {
    saveTokens(loadTokens().filter(t => t.id !== id));
}

export { removeToken as removeInvalidToken };

export function markInvalid(id) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) { tokens[idx].invalid = true; saveTokens(tokens); }
}

export function markValid(id, newToken) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        tokens[idx].invalid = false;
        tokens[idx].resetAt = null;
        if (newToken) tokens[idx].token = newToken;
        saveTokens(tokens);
    }
}

export function findAccountIdForToken(token) {
    if (!token) return null;
    const { accountId } = decodeTokenInfo(token);
    const match = loadTokens().find(t =>
        t.token === token ||
        (accountId && decodeTokenInfo(t.token).accountId === accountId)
    );
    return match?.id || null;
}

// A fresh token read from the Qwen tab must clear `invalid` on the matching
// account even when getAvailableToken() had no usable token at all.
export function markValidForToken(token) {
    if (!token) return false;
    const { accountId } = decodeTokenInfo(token);
    const tokens = loadTokens();
    const idx = tokens.findIndex(t =>
        t.token === token ||
        (accountId && decodeTokenInfo(t.token).accountId === accountId)
    );
    if (idx === -1) return false;
    markValid(tokens[idx].id, token);
    return true;
}

// Sets a human-readable label for the account (to distinguish in the pool).
// Empty string clears the label. Returns { ok, id, label } or { error }.
export function setLabel(id, rawLabel) {
    if (typeof id !== 'string' || !/^acc_[a-zA-Z0-9]+$/.test(id)) {
        return { error: 'Invalid account id' };
    }
    const label = String(rawLabel ?? '').trim().slice(0, 60);
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx === -1) return { error: 'Account not found' };
    tokens[idx].label = label;
    saveTokens(tokens);
    return { ok: true, id, label };
}

// Updates token of an existing account (relogin from dashboard):
// markValid (updates token + resets invalid/resetAt) + rewrites token.txt.
export function updateAccountToken(id, rawToken) {
    if (typeof id !== 'string' || !/^acc_[a-zA-Z0-9]+$/.test(id)) {
        return { error: 'Invalid account id' };
    }
    const token = String(rawToken || '').trim();
    if (!token.startsWith('eyJ') || token.split('.').length !== 3) {
        return { error: 'Invalid token: expected JWT (eyJ...)' };
    }
    const tokens = loadTokens();
    const acc = tokens.find(t => t.id === id);
    if (!acc) return { error: 'Account not found' };
    if (tokens.some(t => t.id !== id && t.token === token)) {
        return { error: 'This token is already used by another account' };
    }
    const dir = path.join(ACCOUNTS_PATH, id);
    if (!path.resolve(dir).startsWith(path.resolve(ACCOUNTS_PATH) + path.sep)) {
        return { error: 'Invalid account path' };
    }
    markValid(id, token);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'token.txt'), token, 'utf8');
    } catch (e) {
        logError('TokenManager: failed to write token.txt for ' + id, e);
    }
    const info = decodeTokenInfo(token);
    return { ok: true, id, exp: info.exp };
}

export function listTokens() {
    return loadTokens();
}

// Decodes JWT payload without signature verification — to display expiration and account id.
export function decodeTokenInfo(token) {
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
        return { exp: payload.exp ? payload.exp * 1000 : null, accountId: payload.id || null };
    } catch {
        return { exp: null, accountId: null };
    }
}

// Adds token manually (from dashboard), without launching browser.
// Returns { id } on success or { error }.
export function addTokenFromString(rawToken, label) {
    const token = String(rawToken || '').trim();
    if (!token.startsWith('eyJ') || token.split('.').length !== 3) {
        return { error: 'Invalid token: expected JWT (eyJ...)' };
    }
    const tokens = loadTokens();
    if (tokens.some(t => t.token === token)) {
        return { error: 'This token is already added' };
    }
    let n = 2;
    const ids = new Set(tokens.map(t => t.id));
    while (ids.has('acc_' + n)) n++;
    const id = 'acc_' + n;

    const accDir = path.join(ACCOUNTS_PATH, id);
    fs.mkdirSync(accDir, { recursive: true });
    fs.writeFileSync(path.join(accDir, 'token.txt'), token, 'utf8');

    tokens.push({ id, token, resetAt: null, label: String(label || '').trim().slice(0, 60) });
    saveTokens(tokens);
    return { id };
}

// Completely removes an account: entry in tokens.json and folder with token.txt.
export function deleteAccount(id) {
    // Protection against path traversal: id is used in filesystem path.
    if (typeof id !== 'string' || !/^acc_[a-zA-Z0-9]+$/.test(id)) {
        return { error: 'Invalid account id' };
    }
    const dir = path.join(ACCOUNTS_PATH, id);
    if (!path.resolve(dir).startsWith(path.resolve(ACCOUNTS_PATH) + path.sep)) {
        return { error: 'Invalid account path' };
    }
    removeToken(id);
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
        logError('TokenManager: failed to delete account folder ' + id, e);
    }
    return { ok: true };
}
