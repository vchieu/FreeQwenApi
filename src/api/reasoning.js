// Reasoning-effort mapping and Qwen thinking-stream helpers.
// Kept pure (no I/O) so scripts/core/verify-reasoning.mjs can check it offline.
// The page.evaluate() SSE parser in chat.js mirrors consumeThinkingDelta inline
// because it cannot import ES modules from inside the browser.

// Exact values captured from real Qwen UI requests (see reference project
// qwen_web2api/config.py). `null` means: delete the key from feature_config.
export const MODE_FEATURE_CONFIG = Object.freeze({
    fast: Object.freeze({
        thinking_enabled: false,
        auto_thinking: false,
        thinking_mode: 'Fast',
        thinking_format: null
    }),
    auto: Object.freeze({
        thinking_enabled: true,
        auto_thinking: true,
        thinking_mode: 'Auto',
        thinking_format: 'summary'
    }),
    thinking: Object.freeze({
        thinking_enabled: true,
        auto_thinking: false,
        thinking_mode: 'Thinking',
        thinking_format: 'summary'
    })
});

// none/minimal/low -> fast, medium -> auto, high/xhigh/max -> thinking.
// Absent/unknown -> null = leave the request's feature_config untouched.
export function modeForReasoningEffort(effort) {
    if (typeof effort !== 'string') return null;
    const e = effort.trim().toLowerCase();
    if (e === 'none' || e === 'minimal' || e === 'low') return 'fast';
    if (e === 'medium') return 'auto';
    if (e === 'high' || e === 'xhigh' || e === 'max') return 'thinking';
    return null;
}

export function reasoningOptionsFromEffort(effort) {
    return {
        reasoningMode: modeForReasoningEffort(effort),
        reasoningEffort: typeof effort === 'string' ? effort.trim().toLowerCase() : null
    };
}

// Mutates the given feature_config in place. Unknown mode => no change at all.
export function applyFeatureConfigMode(featureConfig, mode) {
    const patch = MODE_FEATURE_CONFIG[mode];
    if (!featureConfig || typeof featureConfig !== 'object' || !patch) return featureConfig;
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete featureConfig[key];
        else featureConfig[key] = value;
    }
    return featureConfig;
}

// Qwen changes the shape of `content` between phases: string, array of parts,
// or {content:[...]}. Flatten it without losing thinking text.
export function partsText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(partsText).join('');
    if (value && typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (value.content !== undefined) return partsText(value.content);
    }
    return '';
}

// Flatten a summary field (string | array of strings/parts | {content}) into
// one string, joining distinct parts with `sep`.
export function joinParts(value, sep) {
    const raw = (value && typeof value === 'object' && !Array.isArray(value) && value.content !== undefined)
        ? value.content : value;
    const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
    return list.map(part => partsText(part).trim()).filter(Boolean).join(sep);
}

export function createThinkingAccumulator() {
    return { thought: '', seenTitles: [], blockFinished: false };
}

// Consume one SSE delta (choice.delta / choice.message). Returns the text that
// belongs in reasoning_content and the text that belongs in content. Thinking
// never leaks into content; answer phases never produce reasoning.
export function consumeThinkingDelta(state, delta) {
    const out = { reasoning: '', content: '' };
    if (!delta || typeof delta !== 'object') return out;

    const phase = String(delta.phase || '').toLowerCase();
    const status = String(delta.status || '').toLowerCase();
    const isSummary = phase.includes('summary');
    const isThinking = !isSummary && (phase === 'thinking' || phase === 'think' || phase === 'reasoning');
    const body = delta.content ?? delta.text ?? delta.output_text;

    const directReasoning = partsText(delta.reasoning_content);
    if (directReasoning) {
        out.reasoning += directReasoning;
    } else if (isThinking) {
        out.reasoning += partsText(body);
    }

    if (isSummary) {
        if (status === 'finished') {
            state.blockFinished = true;
            return out;
        }

        const extra = delta.extra || {};
        const rawTitles = extra.summary_title && typeof extra.summary_title === 'object'
            && Object.prototype.hasOwnProperty.call(extra.summary_title, 'content')
            ? extra.summary_title.content : extra.summary_title;
        const titleList = Array.isArray(rawTitles) ? rawTitles : (rawTitles ? [rawTitles] : []);
        for (const item of titleList) {
            const title = partsText(item).trim();
            if (title && !state.seenTitles.includes(title)) {
                state.seenTitles.push(title);
                out.reasoning += `**${title}**\n\n`;
            }
        }

        const thoughtText = joinParts(extra.summary_thought, '\n\n');
        if (thoughtText && thoughtText !== state.thought) {
            let deltaText = '';
            if (state.thought && thoughtText.startsWith(state.thought)) {
                // Cumulative array: only the newly appended suffix is new.
                deltaText = thoughtText.slice(state.thought.length);
                state.thought = thoughtText;
            } else if (state.blockFinished && !thoughtText.startsWith(state.thought)) {
                // Disjoint block after a `status:finished` summary phase.
                deltaText = '\n\n' + thoughtText;
                state.thought = (state.thought ? state.thought + '\n\n' : '') + thoughtText;
            } else if (!state.thought) {
                deltaText = thoughtText;
                state.thought = thoughtText;
            } else {
                // Slightly rewritten prefix: emit from the common prefix.
                let p = 0;
                while (p < state.thought.length && p < thoughtText.length && state.thought[p] === thoughtText[p]) p++;
                deltaText = thoughtText.slice(p);
                state.thought = thoughtText;
            }
            state.blockFinished = false;
            if (deltaText) out.reasoning += deltaText;
        }
        return out;
    }

    if (isThinking) return out;
    out.content += partsText(body);
    return out;
}

// Non-stream upstream responses carry reasoning in one or more choices. Pull
// it out without touching the already-final `content` field.
export function reasoningFromCompletion(data) {
    if (!data || !Array.isArray(data.choices)) return '';
    const state = createThinkingAccumulator();
    let reasoning = '';
    for (const choice of data.choices) {
        const message = choice.message || choice.delta || {};
        reasoning += consumeThinkingDelta(state, message).reasoning;
    }
    return reasoning;
}
