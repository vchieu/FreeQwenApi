// Offline fixtures for src/api/toolCalls.js. No network/browser needed.
import assert from 'node:assert/strict';
import {
    parseToolCalls,
    createNativeToolCallAccumulator,
    collectNativeCall,
    flushNativeToolCalls,
    mergeToolCalls,
    missingRequiredParams,
    toolRequiredParams
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

console.log(`checks: ${checks}`);
console.log(checks === 10 ? 'PASS' : 'FAIL');
process.exit(checks === 10 ? 0 : 1);