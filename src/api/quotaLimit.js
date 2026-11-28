// Pure module: detect Qwen quota limit responses.
// Qwen returns HTTP 200 with a normal-looking response that contains
// `extra: { update_member: true }` and a content message like
// "You've reached today's Qwen4-Max limit..."
// This is NOT a `code: 'RateLimited'` error — it's a successful response
// that signals the account has hit its daily quota.

const QUOTA_LIMIT_PATTERNS = [
    /you'?ve reached today'?s .+ limit/i,
    /upgrade your membership/i,
    /switch to another model/i,
];

/**
 * Check if a delta object signals a quota limit.
 * Primary signal: `delta.extra?.update_member === true`
 * Fallback: content matches quota patterns AND delta.status === 'finished' AND content is short (<300 chars)
 * @param {object} delta - The delta object from choices[0].delta or choices[0].message
 * @returns {boolean}
 */
export function isQuotaLimitDelta(delta) {
    if (!delta) return false;
    
    // Primary signal: extra.update_member
    // If extra.update_member is explicitly false, it's NOT a quota limit
    if (delta.extra && 'update_member' in delta.extra) {
        return delta.extra.update_member === true;
    }
    
    // Fallback: content pattern + finished status + short content
    // Only use fallback if extra field doesn't exist or doesn't have update_member
    const content = delta.content || '';
    if (typeof content !== 'string') return false;
    if (delta.status !== 'finished') return false;
    if (content.length > 300) return false; // Avoid false-positive on long answers discussing "limit"
    
    return QUOTA_LIMIT_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Generate a user-friendly error message for quota limit.
 * @param {string} model - The model name that hit the limit
 * @returns {string}
 */
export function quotaLimitMessage(model) {
    return `You've reached today's quota for ${model}. Please wait until tomorrow or switch to a different model.`;
}
