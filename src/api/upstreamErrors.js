// Pure classification of Qwen upstream error shapes for the Node streaming
// path. The browser evaluate path cannot import ES modules, so it carries a
// marker-delimited mirror of this logic inside page.evaluate; verify-audit-fixes.mjs
// extracts that mirror and compares behavior on identical vectors (gotcha #36).
// The quota detector is passed in so these helpers stay self-contained.

/**
 * Classify one parsed SSE chunk.
 * Returns null for normal chunks, otherwise { status, quotaLimited? }:
 *  - code === 'RateLimited'            -> 429 (gotcha #21: ONLY this code)
 *  - other structured code/error       -> 500 immediately (R3/R3b, no retry)
 *  - quota delta (extra.update_member) -> 429 + quotaLimited (gotcha #35)
 */
export function classifySseChunkError(chunk, isQuotaDelta) {
    if (!chunk || typeof chunk !== 'object') return null;
    if (chunk.code === 'RateLimited') return { status: 429 };
    if (chunk.code && !chunk.choices) return { status: 500 };
    if (chunk.error && !chunk.choices) return { status: 500 };
    const choice = chunk.choices && chunk.choices[0];
    const delta = choice && (choice.delta || choice.message);
    if (isQuotaDelta(delta)) return { status: 429, quotaLimited: true };
    return null;
}

/**
 * Classify a whole JSON body (stream=false responses and non-SSE HTTP 200).
 * Nested shapes count too: success:false, data.code, data.error - the same
 * shapes createChatV2 sees at HTTP 200 (gotcha #8). Only RateLimited -> 429.
 */
export function classifyJsonErrorBody(parsed, isQuotaDelta) {
    if (!parsed || typeof parsed !== 'object') return null;
    const topLevelCode = parsed.code;
    const nestedCode = parsed.data && parsed.data.code;
    const hasStructuredError =
        parsed.success === false ||
        Boolean(parsed.error) ||
        Boolean(parsed.data && parsed.data.error) ||
        Boolean(topLevelCode) ||
        Boolean(nestedCode);
    if (hasStructuredError) {
        const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
        return { status: isRateLimited ? 429 : 500 };
    }
    const choice = parsed.choices && parsed.choices[0];
    const delta = choice && (choice.delta || choice.message);
    if (isQuotaDelta(delta)) return { status: 429, quotaLimited: true };
    return null;
}

/**
 * Human-friendly 429 message. Qwen's RateLimited body carries `num` = cooldown
 * hours; surface it instead of a generic "wait before retrying" (single-account
 * mode has no rotation, so the wait time is the only actionable info).
 */
export function rateLimitMessage(errorBody) {
    let num = NaN;
    try {
        const parsed = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;
        num = Number(parsed?.num ?? parsed?.data?.num);
    } catch { /* body may be plain text */ }
    if (Number.isFinite(num) && num > 0) {
        const totalMinutes = Math.round(num * 60);
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        const cooldown = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
        return `Qwen rate limit reached. Try again in about ${cooldown}.`;
    }
    return 'Qwen rate limit reached. Please wait before retrying.';
}
