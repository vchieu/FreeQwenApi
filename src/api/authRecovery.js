// Pure helpers for recovering from Qwen 401s. No browser I/O here so
// scripts/core/verify-auth-retry.mjs can exercise the decisions offline.

// Qwen sometimes answers with HTTP 200 and a body like
// { success: false, data: { code: "unauthorized", details: "401 Unauthorized" } }
// - treat it exactly like an HTTP 401.
export function isUnauthorizedResult(result = {}) {
    if (result.status === 401) return true;
    const candidates = [result.errorBody, result.error];
    if (result.data) candidates.push(JSON.stringify(result.data));
    return candidates.some(value => {
        if (!value) return false;
        return /401\s+unauthorized|\bunauthorized\b|token has expired/i.test(String(value));
    });
}

function decodeExpiry(token) {
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
        return payload.exp ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}

// A rotated token is only useful when it is different from the one Qwen just
// rejected and not about to expire. Qwen may rotate a token minutes AFTER its
// JWT expiry, hence the caller also needs a forced-refresh path (see chat.js).
export function isUsableRefreshedToken(token, failedToken = null, now = Date.now(), skewMs = 30_000) {
    if (typeof token !== 'string' || !token) return false;
    if (failedToken && token === failedToken) return false;
    const exp = decodeExpiry(token);
    return !exp || exp > now + skewMs;
}

// Only reload tabs the proxy itself created. Reloading the human's Qwen tab
// while they are typing would be destructive.
export function pickProxyOwnedQwenPage(pages = [], basePage = null, pooledPages = []) {
    const pooled = new Set(pooledPages || []);
    const owned = (pages || []).filter(page =>
        page &&
        (typeof page.isClosed !== 'function' || !page.isClosed()) &&
        typeof page.url === 'function' &&
        String(page.url()).includes('chat.qwen.ai') &&
        (page === basePage || pooled.has(page))
    );
    // Prefer a disposable pooled tab; fall back to the base tab from initBrowser.
    return owned.find(page => pooled.has(page)) || owned.find(page => page === basePage) || null;
}

// Decode the Qwen JWT payload (no signature verification) for the account id
// and expiry. `exp` is returned in milliseconds so callers can compare it
// directly against Date.now(). Moved here from the removed tokenManager so
// fileUpload.js / chat.js keep a single pure source for token introspection.
export function decodeTokenInfo(token) {
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
        return {
            accountId: payload.id ?? null,
            exp: payload.exp ? payload.exp * 1000 : null
        };
    } catch {
        return { accountId: null, exp: null };
    }
}
