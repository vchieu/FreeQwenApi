// Usage normalization and fallback token estimation for OpenAI-compatible responses.
// Pure module (no I/O) so offline verification scripts can test it directly.

function toPositiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function estimateTokensFromText(text) {
    if (!text) return 0;
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    if (!str) return 0;
    return Math.max(1, Math.ceil(str.length / 4));
}

export function estimateMessagesTokens(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let totalChars = 0;
    for (const msg of messages) {
        if (!msg) continue;
        if (typeof msg.content === 'string') {
            totalChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (!part) continue;
                if (typeof part === 'string') totalChars += part.length;
                else if (typeof part.text === 'string') totalChars += part.text.length;
                else if (part.type === 'image_url' || part.type === 'image') totalChars += 256;
                else totalChars += 128;
            }
        } else if (msg.content != null) {
            totalChars += String(msg.content).length;
        }
        if (Array.isArray(msg.tool_calls)) {
            totalChars += JSON.stringify(msg.tool_calls).length;
        }
        totalChars += 16; // role / message framing overhead
    }
    return totalChars > 0 ? Math.max(1, Math.ceil(totalChars / 4)) : 0;
}

/**
 * Normalize upstream Qwen / OpenAI usage payloads into standard OpenAI fields
 * (`prompt_tokens`, `completion_tokens`, `total_tokens`), filling missing or
 * zero counts with conservative character-based estimates so clients like
 * OpenCode can track context length and trigger compaction accurately.
 */
export function normalizeUsage(rawUsage, { promptText = '', messages = null, tools = null, completionText = '', reasoningText = '', toolCalls = null } = {}) {
    const u = (rawUsage && typeof rawUsage === 'object') ? rawUsage : {};

    let promptTokens = toPositiveInt(u.prompt_tokens ?? u.input_tokens);
    let completionTokens = toPositiveInt(u.completion_tokens ?? u.output_tokens);

    if (promptTokens === 0) {
        const promptEstimate = promptText
            ? estimateTokensFromText(promptText)
            : (estimateMessagesTokens(messages) + (Array.isArray(tools) && tools.length > 0 ? estimateTokensFromText(tools) : 0));
        promptTokens = promptEstimate;
    }

    if (completionTokens === 0) {
        const toolCallsText = Array.isArray(toolCalls) && toolCalls.length > 0 ? JSON.stringify(toolCalls) : '';
        completionTokens =
            estimateTokensFromText(completionText) +
            estimateTokensFromText(reasoningText) +
            estimateTokensFromText(toolCallsText);
    }

    const totalTokens = toPositiveInt(u.total_tokens) || (promptTokens + completionTokens);

    const out = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens
    };
    if (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object') {
        out.prompt_tokens_details = u.prompt_tokens_details;
    }
    if (u.completion_tokens_details && typeof u.completion_tokens_details === 'object') {
        out.completion_tokens_details = u.completion_tokens_details;
    }
    return out;
}
