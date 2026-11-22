// Offline fixtures for src/api/reasoning.js. No network or browser needed.
import assert from 'node:assert/strict';
import {
    MODE_FEATURE_CONFIG,
    modeForReasoningEffort,
    reasoningOptionsFromEffort,
    applyFeatureConfigMode,
    createThinkingAccumulator,
    consumeThinkingDelta,
    reasoningFromCompletion
} from '../../src/api/reasoning.js';

let checks = 0;
function check(name, fn) {
    fn();
    checks++;
    console.log(`  ok - ${name}`);
}

console.log('Reasoning effort mapping:');
check('reference mode table is exact', () => {
    assert.deepEqual(MODE_FEATURE_CONFIG.fast, {
        thinking_enabled: false, auto_thinking: false, thinking_mode: 'Fast', thinking_format: null
    });
    assert.deepEqual(MODE_FEATURE_CONFIG.auto, {
        thinking_enabled: true, auto_thinking: true, thinking_mode: 'Auto', thinking_format: 'summary'
    });
    assert.deepEqual(MODE_FEATURE_CONFIG.thinking, {
        thinking_enabled: true, auto_thinking: false, thinking_mode: 'Thinking', thinking_format: 'summary'
    });
});

check('effort -> mode table', () => {
    for (const effort of ['none', 'minimal', 'low', ' LOW ', 'Low']) {
        assert.equal(modeForReasoningEffort(effort), 'fast', effort);
    }
    assert.equal(modeForReasoningEffort('medium'), 'auto');
    for (const effort of ['high', 'xhigh', 'max', 'HIGH']) {
        assert.equal(modeForReasoningEffort(effort), 'thinking', effort);
    }
    assert.equal(modeForReasoningEffort(undefined), null);
    assert.equal(modeForReasoningEffort(null), null);
    assert.equal(modeForReasoningEffort('ultra'), null);
    assert.equal(modeForReasoningEffort(123), null);
    assert.deepEqual(reasoningOptionsFromEffort('high'), { reasoningMode: 'thinking', reasoningEffort: 'high' });
});

function defaultFeatureConfig() {
    return {
        thinking_enabled: true, output_schema: 'phase', research_mode: 'normal',
        auto_thinking: true, thinking_mode: 'Auto', thinking_format: 'summary', auto_search: true
    };
}

check('absent/unknown effort leaves feature_config byte-for-byte unchanged', () => {
    for (const mode of [null, undefined, 'ultra']) {
        const fc = defaultFeatureConfig();
        const before = JSON.stringify(fc);
        assert.equal(applyFeatureConfigMode(fc, mode), fc);
        assert.equal(JSON.stringify(fc), before);
    }
});

check('fast deletes thinking_format and sets Fast flags', () => {
    const fc = applyFeatureConfigMode(defaultFeatureConfig(), 'fast');
    assert.equal(fc.thinking_enabled, false);
    assert.equal(fc.auto_thinking, false);
    assert.equal(fc.thinking_mode, 'Fast');
    assert.equal(Object.prototype.hasOwnProperty.call(fc, 'thinking_format'), false);
    assert.equal(fc.output_schema, 'phase');
    assert.equal(fc.auto_search, true);
});

check('auto and thinking configs match the reference', () => {
    const auto = applyFeatureConfigMode(defaultFeatureConfig(), 'auto');
    assert.deepEqual(
        { thinking_enabled: auto.thinking_enabled, auto_thinking: auto.auto_thinking, thinking_mode: auto.thinking_mode, thinking_format: auto.thinking_format },
        { thinking_enabled: true, auto_thinking: true, thinking_mode: 'Auto', thinking_format: 'summary' }
    );
    const thinking = applyFeatureConfigMode(defaultFeatureConfig(), 'thinking');
    assert.deepEqual(
        { thinking_enabled: thinking.thinking_enabled, auto_thinking: thinking.auto_thinking, thinking_mode: thinking.thinking_mode, thinking_format: thinking.thinking_format },
        { thinking_enabled: true, auto_thinking: false, thinking_mode: 'Thinking', thinking_format: 'summary' }
    );
});

console.log('Thinking stream:');
check('cumulative summary_thought emits only new suffixes', () => {
    const state = createThinkingAccumulator();
    assert.deepEqual(consumeThinkingDelta(state, {
        phase: 'thinking_summary',
        extra: { summary_thought: { content: ['First step'] } }
    }), { reasoning: 'First step', content: '' });
    assert.deepEqual(consumeThinkingDelta(state, {
        phase: 'thinking_summary',
        extra: { summary_thought: { content: ['First step', 'Second step'] } }
    }), { reasoning: '\n\nSecond step', content: '' });
    assert.equal(consumeThinkingDelta(state, {
        phase: 'thinking_summary',
        extra: { summary_thought: { content: ['First step', 'Second step'] } }
    }).reasoning, '');
});

check('disjoint blocks after status:finished get a separator', () => {
    const state = createThinkingAccumulator();
    consumeThinkingDelta(state, { phase: 'thinking_summary', extra: { summary_thought: 'Block A' } });
    assert.deepEqual(consumeThinkingDelta(state, { phase: 'thinking_summary', status: 'finished' }), { reasoning: '', content: '' });
    assert.deepEqual(consumeThinkingDelta(state, {
        phase: 'thinking_summary',
        extra: { summary_thought: 'Block B' }
    }), { reasoning: '\n\nBlock B', content: '' });
    assert.equal(state.thought, 'Block A\n\nBlock B');
});

check('summary_title dedup and bold formatting', () => {
    const state = createThinkingAccumulator();
    const titleDelta = { phase: 'thinking_summary', extra: { summary_title: { content: ['Analyzing request'] } } };
    assert.equal(consumeThinkingDelta(state, titleDelta).reasoning, '**Analyzing request**\n\n');
    assert.equal(consumeThinkingDelta(state, titleDelta).reasoning, '');
    assert.equal(consumeThinkingDelta(state, {
        phase: 'thinking_summary', extra: { summary_title: ['Next step'] }
    }).reasoning, '**Next step**\n\n');
});

check('reasoning_content and phase:thinking never leak into content', () => {
    const state = createThinkingAccumulator();
    assert.deepEqual(consumeThinkingDelta(state, {
        phase: 'answer', reasoning_content: [{ type: 'text', text: 'internal trace' }], content: ''
    }), { reasoning: 'internal trace', content: '' });
    assert.deepEqual(consumeThinkingDelta(state, {
        phase: 'thinking', content: [{ type: 'text', text: 'deep thought' }]
    }), { reasoning: 'deep thought', content: '' });
    assert.deepEqual(consumeThinkingDelta(state, {
        phase: 'think', content: 'another trace'
    }), { reasoning: 'another trace', content: '' });
});

check('plain answer text stays in content', () => {
    const state = createThinkingAccumulator();
    assert.deepEqual(consumeThinkingDelta(state, { phase: 'answer', content: 'Hello' }), { reasoning: '', content: 'Hello' });
    assert.deepEqual(consumeThinkingDelta(state, { content: [ { type: 'text', text: ' world' } ] }), { reasoning: '', content: ' world' });
});

check('full mixed stream keeps reasoning and answer separate', () => {
    const state = createThinkingAccumulator();
    const deltas = [
        { phase: 'thinking_summary', extra: { summary_title: { content: ['Plan'] } } },
        { phase: 'thinking_summary', extra: { summary_thought: { content: ['Think A'] } } },
        { phase: 'thinking_summary', extra: { summary_thought: { content: ['Think A', 'Think B'] } } },
        { phase: 'thinking_summary', status: 'finished' },
        { phase: 'thinking_summary', extra: { summary_thought: { content: ['Think C'] } } },
        { phase: 'thinking', content: 'raw thinking' },
        { phase: 'answer', content: 'The answer' }
    ];
    let reasoning = '';
    let content = '';
    for (const delta of deltas) {
        const out = consumeThinkingDelta(state, delta);
        reasoning += out.reasoning;
        content += out.content;
    }
    assert.equal(reasoning, '**Plan**\n\nThink A\n\nThink B\n\nThink Craw thinking');
    assert.equal(content, 'The answer');
    assert.equal(content.includes('Think'), false);
});

check('non-stream completion reasoning extraction', () => {
    const data = {
        choices: [{ index: 0, message: {
            role: 'assistant',
            reasoning_content: 'trace from upstream',
            content: 'final answer'
        } }]
    };
    assert.equal(reasoningFromCompletion(data), 'trace from upstream');
    assert.equal(data.choices[0].message.content, 'final answer');
    assert.equal(reasoningFromCompletion({ choices: [{ message: { content: 'OK' } }] }), '');
});

console.log(`checks: ${checks}`);
console.log(checks === 12 ? 'PASS' : 'FAIL');
process.exit(checks === 12 ? 0 : 1);
