// Pure helpers for transient network failures and Qwen captcha detection.
// Kept free of browser/IO dependencies so verify-resilience.mjs can run offline.

export const CAPTCHA_NOTICE =
    'Please resolve captcha to continue. Check the Qwen browser tab (a desktop alert was triggered); this request will resume automatically once verification is solved.';

const NETWORK_ERROR_RE = /network error|fetch failed|failed to fetch|econnreset|econnrefused|enotfound|ehostunreach|socket hang up|err_network|networkerror|network timeout|request timeout|aborted|the operation was aborted|timeout of \d+ms exceeded|\bterminated\b/i;

// Puppeteer cancels any CDP command (including a long page.evaluate) after
// `protocolTimeout`. Unlike a network fetch failure, the browser fetch may still
// be generating server-side, so recovery has to move to a fresh chat.
const PROTOCOL_TIMEOUT_RE = /runtime\.(?:callfunctionon|evaluate)\s+timed out|protocol\s*timeout|protocolerror|target\s*closed/i;

/**
 * A fetch that dies mid-flight (WAF reset, socket hang up, browser navigation)
 * is worth retrying on the same chat. HTTP/API errors are handled elsewhere,
 * and a partially streamed answer must never be replayed (would duplicate text).
 */
export function isRetryableNetworkError(response = {}) {
    if (!response || response.captcha || response.verification) return false;
    if (response.hasStreamedChunks === true) return false;
    if (Number(response.status) >= 400) return false;
    const text = [response.error, response.statusText].filter(Boolean).join(' ');
    return text ? NETWORK_ERROR_RE.test(String(text)) : false;
}

export function shouldRetryNetworkError(response, retryCount, maxRetryCount = 3) {
    return isRetryableNetworkError(response) && Number(retryCount) < Number(maxRetryCount);
}

/**
 * `Runtime.callFunctionOn timed out` / `Target closed` come from Puppeteer, not
 * from Qwen. They are retryable, but never replay into the old chat: the tab's
 * fetch may still be running upstream. Partial streams are excluded for the
 * same reason as network errors (would duplicate already-delivered text).
 */
export function isProtocolTimeoutError(response = {}) {
    if (!response || response.captcha || response.verification) return false;
    if (response.hasStreamedChunks === true) return false;
    if (Number(response.status) >= 400) return false;
    const text = [response.error, response.statusText].filter(Boolean).join(' ');
    return text ? PROTOCOL_TIMEOUT_RE.test(String(text)) : false;
}

/**
 * Node fetch stalled past NODE_STREAM_TIMEOUT_MS. Just like a protocol timeout,
 * Qwen may still be generating upstream, so recovery must use a fresh chat.
 */
export function isNodeStreamTimeout(response = {}) {
    if (!response || response.captcha || response.verification) return false;
    if (response.hasStreamedChunks === true) return false;
    if (Number(response.status) >= 400) return false;
    return response.nodeTimeout === true;
}

/**
 * Qwen refuses a second message while the previous answer is still generating:
 * HTTP 500 with `data.code = CHAT_IN_PROGRESS`. This happens routinely after a
 * captcha kills the browser fetch - the server-side generation keeps running.
 * Recovery must use a fresh chat, not wait on the abandoned one.
 */
export function isChatInProgress(response = {}) {
    if (!response || response.captcha) return false;
    const body = typeof response.errorBody === 'string'
        ? response.errorBody
        : typeof response.error === 'string' ? response.error : '';
    if (!body) return false;
    return /CHAT_IN_PROGRESS/i.test(body) || /chat\s+is\s+in\s+progress/i.test(body);
}

/** Visibility of an iframe/DOM box reported by puppeteer (`boundingBox()`). */
export function isVisibleBox(box) {
    return !!(box && Number(box.width) > 1 && Number(box.height) > 1);
}

/**
 * Qwen's WAF shows a slider captcha (`nc_1_nocaptcha`) or redirects to
 * `_____tmd_____/report`; the login/verification stage also uses a
 * "Verification" page title. Return null when nothing captcha-like is found.
 */
export function detectCaptchaSignal({ url = '', title = '', text = '', html = '' } = {}) {
    const hay = [url, title, text, html].filter(Boolean).join(' ');
    if (!hay) return null;
    // A slider captcha is usually an iframe whose markers live in attributes
    // (id/class/src), not in body text - keep the match broad enough for that.
    if (/_____tmd_____|[?&/]captcha|captcha\.|baxia|nc_1_|captcha-verify|slider captcha|安全验证|滑块|拖动滑块|向右滑动|按住滑块/i.test(hay)) {
        return 'slider';
    }
    if (/\bverification\b/i.test(String(title || ''))) return 'verification';
    if (/verification required|verify you are human|unusual traffic|security check/i.test(hay)) {
        return 'verification';
    }
    return null;
}

/** Recognize captcha surfaced as an upstream response instead of a page state. */
export function isCaptchaResponse(response = {}) {
    if (!response) return false;
    if (response.captcha === true || response.verification === true) return true;
    return Boolean(detectCaptchaSignal({
        html: response.errorBody || response.html || '',
        text: response.error || '',
        title: response.statusText || ''
    }));
}

/** HTTP status to return to an OpenAI client when sendMessage/createChat fails. */
export function errorResponseStatus(result = {}) {
    const status = Number(result?.status);
    return Number.isFinite(status) && status >= 400 ? status : 500;
}

/** OpenAI error.type for an upstream failure result (used by both SSE and JSON paths). */
export function errorTypeForResult(result = {}) {
    if (result?.quotaLimited || errorResponseStatus(result) === 429) return 'rate_limit_error';
    return 'server_error';
}

/** Build the HTTP status and JSON error body for non-streaming chat endpoints. */
export function nonStreamErrorBody(result = {}) {
    const status = errorResponseStatus(result);
    return {
        status,
        body: {
            error: {
                message: result?.error || 'Request failed',
                type: errorTypeForResult(result),
                ...(status !== 500 ? { status } : {})
            }
        }
    };
}

/** Suppress onReasoning on retries after reasoning chunks have already streamed. */
export function applyRetryReasoningSuppression(options = {}, response = {}) {
    return response?.hasStreamedReasoning ? { ...options, onReasoning: null } : options;
}
