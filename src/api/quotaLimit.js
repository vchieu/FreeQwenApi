// Pure module: detect Qwen quota limit responses.
// Qwen returns HTTP 200 with a normal-looking response that contains
// `extra: { update_member: true }` and a content message like
// "You've reached today's Qwen4-Max limit..."
// This is NOT a `code: 'RateLimited'` error — it's a successful response
// that signals the account has hit its daily quota.

/**
 * Check if a delta object signals a quota limit.
 * Primary signal: `delta.extra?.update_member === true`
 * Fallback: content matches >=2 quota patterns AND delta.status === 'finished'
 * AND content is short (<300 chars). A single weak pattern (e.g. a normal answer
 * saying "switch to another model") must NOT fake a quota error.
 *
 * SELF-CONTAINED on purpose: no module-level references, because the browser
 * evaluate path keeps a behavior-tested mirror of this function (gotcha #36).
 * @param {object} delta - The delta object from choices[0].delta or choices[0].message
 * @returns {boolean}
 */
export function isQuotaLimitDelta(delta) {
    if (!delta) return false;

    // Primary signal: extra.update_member.
    // If extra.update_member is explicitly false, it's NOT a quota limit.
    if (delta.extra && 'update_member' in delta.extra) {
        return delta.extra.update_member === true;
    }

    // Fallback: content patterns + finished status + short content.
    // Only used when extra doesn't exist or doesn't have update_member.
    const content = delta.content || '';
    if (typeof content !== 'string') return false;
    if (delta.status !== 'finished') return false;
    if (content.length > 300) return false; // Avoid false-positive on long answers discussing "limit"

    const patterns = [
        /you'?ve reached today'?s .+ limit/i,
        /upgrade your membership/i,
        /switch to another model/i,
    ];
    let hits = 0;
    for (const pattern of patterns) {
        if (pattern.test(content)) hits++;
    }
    return hits >= 2;
}

/**
 * Generate a user-friendly error message for quota limit.
 * @param {string} model - The model name that hit the limit
 * @returns {string}
 */
export function quotaLimitMessage(model) {
    return `You've reached today's quota for ${model}. Please wait until tomorrow or switch to a different model.`;
}
