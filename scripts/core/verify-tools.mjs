// Offline fixtures for src/api/toolCalls.js. No network/browser needed.
import assert from 'node:assert/strict';
import {
    parseToolCalls,
    createNativeToolCallAccumulator,
    collectNativeCall,
    flushNativeToolCalls,
    mergeToolCalls,
    missingRequiredParams,
    toolRequiredParams,
    messagesToQwenPrompt,
    toolNames
} from '../../src/api/toolCalls.js';

let checks = 0;
function check(name, fn) {
    fn();
    checks++;
    console.log(`  ok - ${name}`);
}

const tools = [
    {
        type: 'function',
        function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_files',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
    }
];
const allowed = new Set(['get_weather', 'search_files']);
const required = toolRequiredParams(tools);

console.log('Text tool-call parsing:');
check('bare JSON', () => {
    const r = parseToolCalls('{"name":"get_weather","arguments":{"city":"Hanoi"}}', allowed, required);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { city: 'Hanoi' });
    assert.equal(r.dropped.length, 0);
});

check('fenced tool_call', () => {
    const r = parseToolCalls('```tool_call\n{"name":"search_files","arguments":{"query":"TODO"}}\n```', allowed, required);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, 'search_files');
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { query: 'TODO' });
});

check('multiple calls', () => {
    const text = '```tool_call\n{"name":"get_weather","arguments":{"city":"Hanoi"}}\n```\n```tool_call\n{"name":"search_files","arguments":{"query":"x"}}\n```';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 2);
    assert.deepEqual(r.calls.map(c => c.function.name), ['get_weather', 'search_files']);
});

check('XML-style call', () => {
    const text = '<tool_call><function=get_weather><parameter=city>Hanoi</parameter></function></tool_call>';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { city: 'Hanoi' });
});

console.log('Validation:');
check('broken arguments rejected', () => {
    const r = parseToolCalls('```tool_call\n{"name":"get_weather","arguments":"{bad json"}\n```', allowed, required);
    assert.equal(r.calls.length, 0);
    assert.ok(r.dropped.some(d => d.includes('unusable arguments')));
});

check('built-in/non-declared names ignored', () => {
    const r = parseToolCalls('```tool_call\n{"name":"code_interpreter","arguments":{"code":"1+1"}}\n```', allowed, required);
    assert.equal(r.calls.length, 0);
    assert.ok(r.dropped.some(d => d.includes('undeclared tool')));
});

check('missing required param reported', () => {
    const r = parseToolCalls('{"name":"get_weather","arguments":{}}', allowed, required);
    assert.equal(r.calls.length, 0);
    assert.ok(r.dropped.some(d => d.includes('missing required parameter')));
});

console.log('Native function_call accumulation:');
check('cumulative native arguments', () => {
    const acc = createNativeToolCallAccumulator();
    collectNativeCall(acc, { id: 'c1', name: 'get_weather', arguments: '{"city":"' }, allowed);
    collectNativeCall(acc, { id: 'c1', name: 'get_weather', arguments: '{"city":"Hanoi"}' }, allowed);
    const flushed = flushNativeToolCalls(acc, allowed);
    assert.equal(flushed.calls.length, 1);
    assert.equal(flushed.calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(flushed.calls[0].function.arguments), { city: 'Hanoi' });
    assert.equal(flushed.dropped.length, 0);
});

check('native undeclared ignored', () => {
    const acc = createNativeToolCallAccumulator();
    collectNativeCall(acc, { id: 'b1', name: 'code_interpreter', arguments: '{"code":"1+1"}' }, allowed);
    const flushed = flushNativeToolCalls(acc, allowed);
    assert.equal(flushed.calls.length, 0);
    assert.ok(flushed.dropped.some(d => d.includes('undeclared tool')));
});

check('merge dedupes identical calls', () => {
    const merged = mergeToolCalls(
        [{ id: '1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' }, index: 0 }],
        [{ id: '2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' }, index: 0 }]
    );
    assert.equal(merged.length, 1);
});

// ─── messagesToQwenPrompt tests ───────────────────────────────────────────────
const READ_TOOL = {
    type: 'function',
    function: {
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
};
const WRITE_TOOL = {
    type: 'function',
    function: {
        name: 'write_file',
        description: 'Write content to a file',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
        },
    },
};

console.log('\nmessagesToQwenPrompt – Tool Use block:');
check('starts with # Tool Use when tools provided', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'Read config.json' }], [READ_TOOL]);
    assert.ok(p.startsWith('# Tool Use'), `expected to start with # Tool Use, got: ${p.slice(0, 60)}`);
});
check('includes ```tool_call call format', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'go' }], [READ_TOOL]);
    assert.ok(p.includes('```tool_call'), 'missing ```tool_call fence in block');
});
check('includes Available tools with read_file', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'go' }], [READ_TOOL]);
    assert.ok(p.includes('"name":"read_file"'), 'read_file missing from Available tools');
});
check('includes both tools when two provided', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'go' }], [READ_TOOL, WRITE_TOOL]);
    assert.ok(p.includes('"name":"read_file"') && p.includes('"name":"write_file"'), 'missing a tool def');
});
check('includes [Reminder:] at end', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'go' }], [READ_TOOL]);
    assert.ok(p.includes('[Reminder:'), 'missing reminder');
});
check('user message present in body', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'Read config.json' }], [READ_TOOL]);
    assert.ok(p.includes('Read config.json'), 'user message missing from prompt');
});

console.log('\nmessagesToQwenPrompt – tool_choice variants:');
check('tool_choice=none suppresses Tool Use block', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'Hello' }], [READ_TOOL], 'none');
    assert.ok(!p.includes('# Tool Use'), '# Tool Use block must not appear when tool_choice=none');
});
check('tool_choice=required adds MUST call instruction', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'go' }], [READ_TOOL], 'required');
    assert.ok(p.includes('You MUST call at least one tool'), 'missing required instruction');
});
check('tool_choice=specific function adds MUST call named tool', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'go' }], [READ_TOOL],
        { type: 'function', function: { name: 'read_file' } });
    assert.ok(p.includes('You MUST call the tool "read_file"'), 'missing specific tool instruction');
});

console.log('\nmessagesToQwenPrompt – message roles:');
check('system message labelled [System instruction]:', () => {
    const p = messagesToQwenPrompt(
        [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'go' }],
        [READ_TOOL],
    );
    assert.ok(p.includes('[System instruction]: Be helpful.'), 'system label missing');
});
check('assistant text reply labelled [Assistant]:', () => {
    const p = messagesToQwenPrompt(
        [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Answer.' }, { role: 'user', content: 'next' }],
        [READ_TOOL],
    );
    assert.ok(p.includes('[Assistant]: Answer.'), '[Assistant]: label missing');
});
check('assistant tool_call renders fence + result inlined', () => {
    const msgs = [
        { role: 'user', content: 'Read config.json' },
        {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'call_x1', type: 'function', function: { name: 'read_file', arguments: '{"path":"config.json"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_x1', name: 'read_file', content: '{"key":"v"}' },
        { role: 'user', content: 'What is in key?' },
    ];
    const p = messagesToQwenPrompt(msgs, [READ_TOOL]);
    assert.ok(p.includes('```tool_call'), 'tool_call fence missing from history');
    assert.ok(p.includes('"name":"read_file"'), 'tool name missing from fence');
    assert.ok(p.includes('[Tool result for read_file (id=call_x1)]: {"key":"v"}'), 'inlined tool result missing');
    assert.ok(p.includes('What is in key?'), 'follow-up user message missing');
});
check('orphan tool result (not inlined) still rendered', () => {
    const msgs = [
        { role: 'user', content: 'go' },
        { role: 'tool', tool_call_id: 'call_z9', name: 'read_file', content: 'data' },
    ];
    const p = messagesToQwenPrompt(msgs, [READ_TOOL]);
    assert.ok(p.includes('[Tool result for read_file (id=call_z9)]: data'), 'orphan tool result missing');
});

console.log('\nmessagesToQwenPrompt – no tools:');
check('no Tool Use block when tools array empty', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'Hello' }], []);
    assert.ok(!p.includes('# Tool Use'), '# Tool Use must not appear when no tools');
});
check('returns plain user message when no tools', () => {
    const p = messagesToQwenPrompt([{ role: 'user', content: 'Hello' }]);
    assert.equal(p.trim(), 'Hello');
});

console.log('\nmessagesToQwenPrompt – round-trip parse:');
check('round-trip: qwen fence response -> parseToolCalls succeeds', () => {
    const qwenReply = '```tool_call\n{"name": "read_file", "arguments": {"path": "config.json"}}\n```';
    const result = parseToolCalls(qwenReply, toolNames([READ_TOOL]));
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].function.name, 'read_file');
    assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { path: 'config.json' });
    assert.equal(result.dropped.length, 0);
});

const TOTAL = 10 + 16;
console.log(`\nchecks: ${checks}`);
console.log(checks === TOTAL ? 'PASS' : `FAIL (expected ${TOTAL} checks, got ${checks})`);
process.exit(checks === TOTAL ? 0 : 1);