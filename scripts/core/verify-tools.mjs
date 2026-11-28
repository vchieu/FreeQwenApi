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
    toolNames,
    shouldRetryToolCall
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

console.log('\nparseToolCalls – prose + tool_call splitting:');
check('fence on its own line -> call extracted, cleanText is empty', () => {
    const fence = '```tool_call\n{"name":"read_file","arguments":{"path":"foo.txt"}}\n```';
    const r = parseToolCalls(fence, toolNames([READ_TOOL]));
    assert.equal(r.calls.length, 1);
    assert.equal(r.text.length, 0); // no prose
});

check('prose before fence on separate line -> call extracted, prose preserved in cleanText', () => {
    const text = 'Sure, let me read that file for you.\n```tool_call\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```';
    const r = parseToolCalls(text, toolNames([READ_TOOL]));
    assert.equal(r.calls.length, 1, 'should extract call');
    assert.ok(r.text.includes('Sure, let me read that file for you.'), 'prose preserved in cleanText');
    assert.ok(!r.text.includes('```tool_call'), 'fence stripped from cleanText');
});

check('fence mid-sentence (prose on same line before it) -> block skipped (not a real call)', () => {
    // Model wrote: "I will call ```tool_call..." - this is a description, not a call
    const text = 'I will call ```tool_call\n{"name":"read_file","arguments":{"path":"b.txt"}}\n```';
    const r = parseToolCalls(text, toolNames([READ_TOOL]));
    assert.equal(r.calls.length, 0, 'mid-sentence fence should not be treated as a call');
    assert.ok(r.text.includes('{"name":"read_file"'), 'rejected fence stays as text, not a call');
});

check('cleanText has prose but no fence when tool call present', () => {
    const text = 'Here is the answer.\n```tool_call\n{"name":"read_file","arguments":{"path":"c.txt"}}\n```\nEnd.';
    const r = parseToolCalls(text, toolNames([READ_TOOL]));
    assert.equal(r.calls.length, 1);
    assert.ok(!r.text.includes('```tool_call'), 'fence stripped');
    assert.ok(r.text.includes('Here is the answer.') || r.text.includes('End.'), 'prose kept');
});


console.log('\ntext tool-call fallback (bare JSON):');
check('bare JSON mixed with prose is NOT executed (prevents example/warning execution)', () => {
    const text = 'Do NOT run it: {"name":"get_weather","arguments":{"city":"Hanoi"}}';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 0);
    assert.ok(r.text.includes('Do NOT run it:'));
    assert.ok(r.text.includes('"name":"get_weather"'));
});

check('tool-shaped JSON inside ```js or ```bash fence is NOT executed', () => {
    const text = 'Example:\n```js\n{"name":"get_weather","arguments":{"city":"Hanoi"}}\n```';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 0);
    assert.ok(r.text.includes('```js'));
});

check('whole-message multiple bare JSON calls -> both extracted', () => {
    const text = '{"name":"get_weather","arguments":{"city":"Hanoi"}}\n{"name":"search_files","arguments":{"query":"TODO"}}';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 2);
    assert.deepEqual(r.calls.map(c => c.function.name), ['get_weather', 'search_files']);
    assert.equal(r.text, '');
});

check('plain JSON answer without tool shape stays text', () => {
    const r = parseToolCalls('{"name":"Alice","age":30}', allowed, required);
    assert.equal(r.calls.length, 0);
    assert.ok(r.text.includes('Alice'), 'ordinary JSON answer preserved');
});

check('native call + bare JSON call merge without duplication', () => {
    const native = [{ id: 'n1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' }, index: 0 }];
    const parsed = parseToolCalls('{"name":"search_files","arguments":{"query":"x"}}', allowed, required);
    const merged = mergeToolCalls(native, parsed.calls);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map(c => c.function.name), ['get_weather', 'search_files']);
});

console.log('\nparseLenientJson – Qwen malformed tool call recovery:');
check('{"name":"foo",{...}} missing arguments key recovered', () => {
    // Qwen sometimes omits "arguments": key: {"name":"read_file",{"path":"x.js"}}
    const text = '```tool_call\n{"name":"read_file",{"path":"x.js"}}\n```';
    const r = parseToolCalls(text, toolNames([READ_TOOL]));
    assert.equal(r.calls.length, 1, 'should recover call despite missing arguments key');
    assert.equal(r.calls[0].function.name, 'read_file');
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: 'x.js' });
});

console.log('\nMalformed tool_call blocks & nudge-retry decision:');
check('nested bracket mismatch inside tool_call fence (question regression) records dropped', () => {
    const text = '```tool_call\n{"name":"question","arguments":{"questions":[{"question":"Q1","header":"H1","options":[{"label":"A","description":"desc"}]},{"question":"Q2","header":"H2","options":[{"label":"B","description":"desc2"}]}]}}\n```'.replace('"options":[{"label":"A","description":"desc"}]}', '"options":[{"label":"A","description":"desc"]}]');
    const r = parseToolCalls(text, new Set(['question']), { question: new Set(['questions']) });
    assert.equal(r.calls.length, 0, 'broken JSON must not emit bogus call');
    assert.ok(r.dropped.length > 0, 'broken tool_call fence must record dropped reason for retry');
});

check('completely invalid JSON inside tool_call fence records dropped', () => {
    const r = parseToolCalls('```tool_call\n{bad json\n```', allowed, required);
    assert.equal(r.calls.length, 0);
    assert.ok(r.dropped.length > 0, 'invalid JSON in tool_call fence must record dropped');
});

check('malformed XML <tool_call> block records dropped', () => {
    const r = parseToolCalls('<tool_call>{bad json</tool_call>', allowed, required);
    assert.equal(r.calls.length, 0);
    assert.ok(r.dropped.length > 0, 'invalid XML tool_call must record dropped');
});

check('ordinary ```json fence without tool shape stays text with no dropped', () => {
    const r = parseToolCalls('```json\n{"label":"Big Pickle","description":"coding"}\n```', allowed, required);
    assert.equal(r.calls.length, 0);
    assert.equal(r.dropped.length, 0);
    assert.ok(r.text.includes('Big Pickle'), 'ordinary json fence preserved as answer text');
});

check('shouldRetryToolCall retries when dropped non-empty', () => {
    assert.equal(shouldRetryToolCall({ merged: [], dropped: ['malformed tool_call block'], toolChoice: 'auto' }), true);
    assert.equal(shouldRetryToolCall({ merged: [{ id: '1' }], dropped: ['x'], toolChoice: 'auto' }), false);
});

check('shouldRetryToolCall skips plain-text answer under tool_choice=auto', () => {
    assert.equal(shouldRetryToolCall({ merged: [], dropped: [], toolChoice: 'auto' }), false);
    assert.equal(shouldRetryToolCall({ merged: [], dropped: [], toolChoice: null }), false);
    assert.equal(shouldRetryToolCall({ merged: [], dropped: ['x'], toolChoice: 'none' }), false);
});

check('shouldRetryToolCall retries when tool_choice requires a tool', () => {
    assert.equal(shouldRetryToolCall({ merged: [], dropped: [], toolChoice: 'required' }), true);
    assert.equal(shouldRetryToolCall({ merged: [], dropped: [], toolChoice: { type: 'function', function: { name: 'question' } } }), true);
});

console.log('\nAudit hardening regressions:');
check('trailing comma inside string literal is NOT stripped during lenient repair', () => {
    const text = '```tool_call\n{"name":"write_file","arguments":{"path":"a.js","content":"x = [1, 2, ]",},}\n```';
    const r = parseToolCalls(text, toolNames([WRITE_TOOL]));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: 'a.js', content: 'x = [1, 2, ]' });
});

check('truncated XML <tool_call> without closing tags is rejected as malformed', () => {
    const text = '<tool_call><function=write_file><parameter=path>a.txt</parameter><parameter=content>line1\nline2 cut he';
    const r = parseToolCalls(text, toolNames([WRITE_TOOL]));
    assert.equal(r.calls.length, 0);
    assert.ok(r.dropped.length > 0);
});

check('truncated XML <parameter> inside closed </function> is rejected as malformed', () => {
    const text = '<tool_call><function=write_file><parameter=path>a.txt</parameter><parameter=content>line2 cut</function></tool_call>';
    const r = parseToolCalls(text, toolNames([WRITE_TOOL]));
    assert.equal(r.calls.length, 0);
    assert.ok(r.dropped.length > 0);
});

check('mid-sentence explicit tool_call fence records dropped and returns soft nudge (finding #2)', () => {
    const text = 'Let me read it: ```tool_call\n{"name":"read_file","arguments":{"path":"b.txt"}}\n```';
    const r = parseToolCalls(text, toolNames([READ_TOOL]));
    assert.equal(r.calls.length, 0);
    assert.ok(r.dropped.length > 0, 'mid-sentence drop must still be recorded');
    // Finding #2 fix: mid-sentence drops trigger a SOFT nudge (not false=no retry, not true=aggressive nudge).
    // The soft nudge says "if you meant a tool call, place it on its own line; if example, reply normally".
    assert.equal(shouldRetryToolCall({ merged: [], dropped: r.dropped, toolChoice: 'auto' }), 'soft',
        'shouldRetryToolCall must return soft nudge for mid-sentence explanation fence');
});

check('2 calls with 1 missing required param keeps the valid call', () => {
    const text = '```tool_call\n{"name":"get_weather","arguments":{"city":"Hanoi"}}\n```\n```tool_call\n{"name":"search_files","arguments":{}}\n```';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, 'get_weather');
    assert.ok(r.dropped.some(d => d.includes('search_files.query')));
});

check('Windows path with unescaped backslashes parses cleanly', () => {
    const text = '```tool_call\n{"name":"read_file","arguments":{"path":"C:\\Users\\Admin\\Desktop\\sample.txt"}}\n```';
    const r = parseToolCalls(text, toolNames([READ_TOOL]));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: 'C:\\Users\\Admin\\Desktop\\sample.txt' });
});

check('duplicate or model-supplied tool call IDs are never reused', () => {
    const text = '```tool_call\n{"id":"call_a","name":"get_weather","arguments":{"city":"Hanoi"}}\n```\n```tool_call\n{"id":"call_a","name":"search_files","arguments":{"query":"x"}}\n```';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 2);
    assert.notEqual(r.calls[0].id, 'call_a');
    assert.notEqual(r.calls[1].id, 'call_a');
    assert.notEqual(r.calls[0].id, r.calls[1].id);
});

check('messagesToQwenPrompt renders file parts cleanly without [object Object]', () => {
    const msgs = [{ role: 'user', content: [{ type: 'file', file: { filename: 'spec.pdf', file_data: 'data:application/pdf;base64,AA==' } }, { type: 'text', text: 'Summarize' }] }];
    const p = messagesToQwenPrompt(msgs, [READ_TOOL]);
    assert.ok(p.includes('[file: spec.pdf]'));
    assert.ok(!p.includes('[object Object]'));
});

// --- R1/finding-#2 regression: mid-sentence block is a prose example, nudge softly not aggressively ---
console.log('\nR1/R7 regression fixes:');
check('R1: mid-sentence drop triggers SOFT nudge, not aggressive nudge', () => {
    const midSentenceDrop = ['mid-sentence json block ignored (preceded by text on same line)'];
    // Finding #2 fix: mid-sentence drops now return 'soft' (neutral nudge), not false (no retry).
    // This prevents agent stall while avoiding aggressive "Use a tool NOW" on examples.
    assert.equal(shouldRetryToolCall({ merged: [], dropped: midSentenceDrop, toolChoice: 'auto' }), 'soft',
        'mid-sentence drop must trigger soft nudge (not no-retry and not aggressive nudge)');
    // A real malformed drop alongside a mid-sentence drop should still retry aggressively.
    const mixed = [...midSentenceDrop, 'malformed tool_call block (invalid JSON or missing tool call)'];
    assert.equal(shouldRetryToolCall({ merged: [], dropped: mixed, toolChoice: 'auto' }), true,
        'real malformed drop alongside mid-sentence drop must still retry aggressively');
});

check('R1: explanation fence in middle of prose gives 0 calls, 1 drop (mid-sentence), soft nudge', () => {
    const text = 'The model writes ```tool_call\n{"name":"bash","arguments":{"command":"rm -rf build"}}\n``` and the proxy converts it.';
    const r = parseToolCalls(text, new Set(['bash']));
    assert.equal(r.calls.length, 0, 'explanation fence must not produce calls');
    assert.ok(r.dropped.some(d => d.includes('mid-sentence')), 'must record mid-sentence drop');
    // Soft nudge (not false): agent retries with neutral message, not aggressive "Use a tool NOW".
    assert.equal(shouldRetryToolCall({ merged: r.calls, dropped: r.dropped, toolChoice: 'auto' }), 'soft',
        'shouldRetryToolCall must return soft nudge for explanation fence (finding #2 fix)');
});

check('R7/finding-#1: prose + bare JSON on new line is NOT executed, triggers soft nudge', () => {
    // After finding #1 fix: prose + newline + JSON is dangerous (could be an example/warning).
    // We must NOT execute it; instead record a neutral drop so caller can nudge softly.
    const text = 'I will read the file.\n{"name":"get_weather","arguments":{"city":"Hanoi"}}';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 0, 'prose + newline + bare JSON must NOT produce calls (finding #1 fix)');
    assert.ok(r.dropped.some(d => d.startsWith('bare-json-after-prose')),
        'must record bare-json-after-prose drop for neutral nudge');
    // Finding #2 fix: bare-json-after-prose also returns soft nudge so agent does not stall.
    assert.equal(shouldRetryToolCall({ merged: r.calls, dropped: r.dropped, toolChoice: 'auto' }), 'soft',
        'bare-json-after-prose drop must trigger SOFT nudge to avoid agent stall (finding #2 fix)');
});

check('R7: bare JSON mid-sentence is NOT accepted', () => {
    const text = 'do NOT run it: {"name":"get_weather","arguments":{"city":"Hanoi"}}';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 0, 'mid-sentence bare JSON must not produce calls');
    assert.equal(r.dropped.length, 0, 'mid-sentence bare JSON must not add dropped (it is just prose)');
});

check('R7: tool-shaped JSON inside non-tool fence (```js) is NOT accepted', () => {
    const text = 'Example:\n```js\n{"name":"get_weather","arguments":{"city":"Hanoi"}}\n```';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 0, 'JSON inside ```js fence must not produce calls');
    assert.ok(r.text.includes('```js'), 'fence content must be preserved as text');
});

// --- New regression tests: unclosed fences, Windows paths, R8 break-on-bad-call ---
console.log('\nNew regression tests (unclosed fence, Windows path, R8):');

check('unclosed ```json fence with valid tool JSON is NEVER executed', () => {
    // Unclosed ```json is likely markdown prose — never execute regardless of content.
    const text = 'Do NOT run this:\n```json\n{"name":"bash","arguments":{"command":"rm -rf build"}}\nThat would delete everything.';
    const r = parseToolCalls(text, new Set(['bash']));
    assert.equal(r.calls.length, 0, 'unclosed ```json fence must NEVER produce calls');
    // dropped or not: either way 0 calls
});

check('unclosed ```tool_call fence with trailing prose is NOT executed (mid-sentence sentinel)', () => {
    // Unclosed ```tool_call with text after the JSON → model is writing an example.
    const text = 'The model writes:\n```tool_call\n{"name":"bash","arguments":{"command":"rm -rf build"}}\nand the proxy executes it.';
    const r = parseToolCalls(text, new Set(['bash']));
    assert.equal(r.calls.length, 0, 'unclosed tool_call with trailing prose must not produce calls');
    assert.ok(r.dropped.some(d => d.includes('mid-sentence') || d.includes('unclosed')),
        'must record a mid-sentence or unclosed drop reason');
});

check('unclosed ```tool_call fence with ONLY JSON (no trailing prose) IS executed', () => {
    // Unclosed ```tool_call with nothing after JSON → genuine tool call, execute.
    const text = '```tool_call\n{"name":"get_weather","arguments":{"city":"Hanoi"}}';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 1, 'unclosed tool_call with only JSON must produce 1 call');
    assert.equal(r.calls[0].function.name, 'get_weather');
});

check('Windows path C:\\Users\\... in tool_call fence arrives with backslash separators (not control chars)', () => {
    // Regression test for #3: backslash escape repair must not corrupt C:\Users\new\test -> newline/tab.
    const text = '```tool_call\n{"name":"read_file","arguments":{"path":"C:\\\\Users\\\\Admin\\\\new\\\\test.js"}}\n```';
    const r = parseToolCalls(text, toolNames([READ_TOOL]));
    assert.equal(r.calls.length, 1, 'Windows path must produce 1 call');
    const args = JSON.parse(r.calls[0].function.arguments);
    // The path must contain backslashes (file separators), NOT newlines/tabs/formfeeds.
    assert.ok(!args.path.includes('\n') && !args.path.includes('\t') && !args.path.includes('\f'),
        'path must not contain control chars (\\n, \\t, \\f) — backslash corruption regression');
    assert.ok(args.path.includes('\\'), 'path must still contain backslash separators');
});

check('R8: undeclared tool first → breaks, subsequent valid call NOT executed', () => {
    // When an undeclared tool appears first, addNormalizedCalls must break and skip subsequent calls.
    const text = '```tool_call\n{"name":"undeclared_tool","arguments":{}}\n```\n```tool_call\n{"name":"get_weather","arguments":{"city":"Hanoi"}}\n```';
    const r = parseToolCalls(text, allowed, required);
    // The undeclared tool is dropped; because break is used, the valid second call must NOT be executed.
    assert.equal(r.calls.length, 0, 'undeclared tool first must break and prevent subsequent calls from running');
    assert.ok(r.dropped.some(d => d.includes('undeclared')), 'must record undeclared tool drop');
});

check('R8: bad args on first call → breaks, subsequent valid call NOT executed', () => {
    // When first call has unparseable arguments, subsequent calls must be suppressed.
    const text = '```tool_call\n{"name":"get_weather","arguments":"INVALID JSON HERE"}\n```\n```tool_call\n{"name":"search_files","arguments":{"query":"x"}}\n```';
    const r = parseToolCalls(text, allowed, required);
    // First call has unusable args; second must not run.
    assert.equal(r.calls.length, 0, 'bad args on first call must break and prevent subsequent calls from running');
});

check('Fix D (R8): malformed first block stops subsequent valid block', () => {
    // A malformed ```tool_call block (broken JSON) must set ctx.stopped so the next block
    // is not processed either — dependent calls must not run with a broken predecessor.
    const text = '```tool_call\nINVALID JSON\n```\n```tool_call\n{"name":"get_weather","arguments":{"city":"Hanoi"}}\n```';
    const r = parseToolCalls(text, allowed, required);
    assert.equal(r.calls.length, 0, 'malformed first block must stop subsequent valid block');
    assert.ok(r.dropped.some(d => d.includes('malformed')), 'must record malformed drop');
});

check('Fix B: filePath (camelCase) with unescaped Windows path is treated as path param', () => {
    // OpenCode uses filePath (camelCase). Use UNESCAPED backslashes (\U, \n, \t) so this test
    // actually exercises parseLenientJson + restoreArgsPathParams and fails if case-folding is reverted.
    const rawUnescaped = '```tool_call\n{"name":"read_file","arguments":{"filePath":"C:\\Users\\new\\test.js"}}\n```';
    const r1 = parseToolCalls(rawUnescaped, toolNames([READ_TOOL]));
    assert.equal(r1.calls.length, 1, 'filePath with unescaped C:\\Users\\new\\test.js must produce 1 call');
    const args1 = JSON.parse(r1.calls[0].function.arguments);
    assert.equal(args1.filePath, 'C:\\Users\\new\\test.js', 'filePath must preserve exact Windows separators');

    // Also verify valid JSON where \n and \t would decode to newline/tab without restoreArgsPathParams:
    const rawCtrl = '```tool_call\n{"name":"read_file","arguments":{"filePath":"C:\\new\\test.js"}}\n```';
    const r2 = parseToolCalls(rawCtrl, toolNames([READ_TOOL]));
    assert.equal(r2.calls.length, 1);
    const args2 = JSON.parse(r2.calls[0].function.arguments);
    assert.equal(args2.filePath, 'C:\\new\\test.js', 'filePath must restore \\n and \\t back to path separators');
});

check('Fix 1 (R9): workdir is treated as a path param (allowed after backslash repair)', () => {
    const rawJson = '{"name":"bash","arguments":{"workdir":"C:\\Users\\new\\proj"}}';
    const text = `\`\`\`tool_call\n${rawJson}\n\`\`\``;
    const r = parseToolCalls(text, new Set(['bash']));
    assert.equal(r.calls.length, 1, 'workdir with Windows backslashes must be accepted as a path param');
    const args = JSON.parse(r.calls[0].function.arguments);
    assert.equal(args.workdir, 'C:\\Users\\new\\proj');
});

check('Fix B: content param with real newlines is NOT path-restored (multiline content regression)', () => {
    // content may hold file bodies with real newlines.
    // restoreArgsPathParams must NOT touch content — restoring \\n there corrupts file bodies.
    const content = 'line1\nline2\nline3';
    const text = `\`\`\`tool_call\n{"name":"write_file","arguments":{"path":"test.js","content":${JSON.stringify(content)}}}\n\`\`\``;
    const r = parseToolCalls(text, new Set(['write_file']));
    assert.equal(r.calls.length, 1, 'write_file with multiline content must produce 1 call');
    const args = JSON.parse(r.calls[0].function.arguments);
    assert.ok(args.content.includes('\n'), 'content with real newlines must be preserved, not corrupted');
    assert.equal(args.path, 'test.js', 'path must be preserved as-is');
});

check('Fix C: tool_choice=required returns true even with only mid-sentence drops (not soft)', () => {
    // When toolChoice is required, the caller MUST call a tool. Mid-sentence drops must NOT
    // downgrade the decision to soft — the client declared the tool is required.
    const midSentenceDrop = ['mid-sentence json block ignored (preceded by text on same line)'];
    const result = shouldRetryToolCall({ merged: [], dropped: midSentenceDrop, toolChoice: 'required' });
    assert.equal(result, true, 'tool_choice=required must return true (aggressive nudge), not soft');
});

check('Fix C: tool_choice=required with no drops also returns true', () => {
    assert.equal(shouldRetryToolCall({ merged: [], dropped: [], toolChoice: 'required' }), true,
        'tool_choice=required with no drops must still return true');
});

check('Fix 1 (R9): command param with bare Windows path backslashes is rejected (not silently corrupted)', () => {
    // `type C:\Users\me\new.txt` — \n and \t in path would corrupt the shell command.
    // parseLenientJson must mark it as slash-repair, addNormalizedCalls must reject it.
    // The model should use proper JSON escaping: "type C:\\Users\\me\\new.txt".
    const rawJson = '{"name":"bash","arguments":{"command":"type C:\\Users\\me\\new.txt"}}';
    const text = `\`\`\`tool_call\n${rawJson}\n\`\`\``;
    const r = parseToolCalls(text, new Set(['bash']));
    assert.equal(r.calls.length, 0, 'command with unescaped Windows path must be rejected (backslash-repair corruption)');
    assert.ok(r.dropped.some(d => d.includes('backslash-repair') || d.includes('corrupt')),
        'must record backslash-repair rejection reason');
});

check('Fix 1 (R9): content param with regex backslashes is rejected (not silently corrupted)', () => {
    // /\bfoo\d+\b/ — \b inside content would become backspace char after repair.
    const rawJson = '{"name":"write_file","arguments":{"path":"test.js","content":"/\\bfoo\\d+\\b/"}}';
    const text = `\`\`\`tool_call\n${rawJson}\n\`\`\``;
    const r = parseToolCalls(text, new Set(['write_file']));
    assert.equal(r.calls.length, 0, 'content with regex backslashes must be rejected (backslash-repair corruption)');
    assert.ok(r.dropped.some(d => d.includes('backslash-repair') || d.includes('corrupt')),
        'must record backslash-repair rejection reason for content param');
});

check('Fix 2 (R9): broken ```json fence with tool shape stops subsequent fence', () => {
    // write_file has unescaped " in content → JSON parse fails; raw block has "name"+"arguments"
    // → must be malformed → ctx.stopped → next ```json (sh deploy.sh) must NOT run.
    const badWrite = '{"name":"write_file","arguments":{"path":"a.sh","content":"echo "hello""}}';
    const goodBash = '{"name":"bash","arguments":{"command":"sh a.sh"}}';
    const text = `\`\`\`json\n${badWrite}\n\`\`\`\n\`\`\`json\n${goodBash}\n\`\`\``;
    const r = parseToolCalls(text, new Set(['write_file', 'bash']));
    assert.equal(r.calls.length, 0, 'broken json fence with tool shape must stop subsequent fence');
    assert.ok(r.dropped.some(d => d.includes('malformed')),
        'must record malformed drop reason');
});

check('Fix 2 (R9): broken ```json fence WITHOUT tool shape does NOT stop subsequent fence', () => {
    // A plain config object with broken JSON is not a tool call → no malformed stop.
    // The subsequent valid tool call should still run.
    const notATool = '{"host":"db","port":5432,"pass":"my"password"}';  // broken JSON, no name/arguments
    const goodCall = '{"name":"get_weather","arguments":{"city":"Hanoi"}}';
    // In a json fence, tool call is only acted on when isJsonFenceToolCall → true.
    // The broken plain-JSON fence is skipped (no malformed stop), next fence runs.
    const text = `\`\`\`json\n${notATool}\n\`\`\`\n\`\`\`json\n${goodCall}\n\`\`\``;
    const r = parseToolCalls(text, allowed, required);
    // The second block is a valid tool call in a json fence — should be executed.
    assert.equal(r.calls.length, 1, 'non-tool broken json fence must NOT stop subsequent valid tool call');
    assert.equal(r.calls[0].function.name, 'get_weather');
});

const TOTAL = 10 + 16 + 4 + 5 + 1 + 7 + 8 + 5 + 6 + 5 + 5; // +5 new R9 tests (incl. workdir)
console.log(`\nchecks: ${checks}`);
console.log(checks === TOTAL ? 'PASS' : `FAIL (expected ${TOTAL} checks, got ${checks})`);
process.exit(checks === TOTAL ? 0 : 1);