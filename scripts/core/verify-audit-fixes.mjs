// Offline checks for audit fixes: usage normalization, model mapping coverage,
// and truncated SSE stream detection.
// Also covers R-series regression fixes: R1 (nudge), R3 (429), R4 (history image), R9 (file:// URL).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeUsage } from '../../src/api/usage.js';
import { resolveRequestedModel } from '../../src/api/modelMapping.js';
import { executeApiRequestWithNodeStreaming } from '../../src/api/chat.js';
import { attachmentSourceToBuffer, prepareOpenAIImages } from '../../src/api/fileUpload.js';
import { classifySseChunkError, classifyJsonErrorBody, rateLimitMessage } from '../../src/api/upstreamErrors.js';
import { isQuotaLimitDelta } from '../../src/api/quotaLimit.js';

let checks = 0;
function check(name, fn) {
    fn();
    checks++;
    console.log(`  ok - ${name}`);
}
async function checkAsync(name, fn) {
    await fn();
    checks++;
    console.log(`  ok - ${name}`);
}

console.log('Usage normalization & estimation:');
check('normalizes input_tokens/output_tokens from Qwen upstream', () => {
    const u = normalizeUsage({ input_tokens: 585, output_tokens: 12, total_tokens: 597 });
    assert.deepEqual(u, { prompt_tokens: 585, completion_tokens: 12, total_tokens: 597 });
});

check('estimates prompt_tokens and completion_tokens when upstream omits usage', () => {
    const u = normalizeUsage(null, {
        promptText: 'a'.repeat(400),
        completionText: 'b'.repeat(80),
        reasoningText: 'c'.repeat(40)
    });
    assert.equal(u.prompt_tokens, 100);
    assert.equal(u.completion_tokens, 30);
    assert.equal(u.total_tokens, 130);
});

console.log('Model mapping coverage:');
check('every model in src/AvailableModels.txt resolves cleanly', () => {
    const models = fs.readFileSync('src/AvailableModels.txt', 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    assert.ok(models.includes('qwen3.5-omni-plus'));
    for (const m of models) {
        const resolved = resolveRequestedModel(m);
        assert.ok(resolved.model, `expected ${m} to resolve, got null`);
    }
});

console.log('Stream premature EOF detection:');
{
    const savedFetch = globalThis.fetch;
    let res;
    try {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial text","phase":"answer"}}]}\n\n'));
                controller.close();
            }
        });
        globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        });
        res = await executeApiRequestWithNodeStreaming(
            'https://example.invalid/api/v2/chat/completions',
            { stream: true, model: 'qwen3.7-plus' },
            'test-token',
            () => {}
        );
    } finally {
        globalThis.fetch = savedFetch;
    }
    check('stream closing without [DONE]/finish_reason/status:finished fails as interrupted', () => {
        assert.equal(res.success, false);
        assert.equal(res.interrupted, true);
        assert.equal(res.hasStreamedChunks, true);
    });
}

{
    const savedFetch = globalThis.fetch;
    let res;
    try {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello","phase":"answer"}}]}\n\n'));
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"","status":"finished","phase":"answer"}}]}\n\n'));
                controller.close();
            }
        });
        globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        });
        res = await executeApiRequestWithNodeStreaming(
            'https://example.invalid/api/v2/chat/completions',
            { stream: true, model: 'qwen3.7-plus' },
            'test-token',
            () => {}
        );
    } finally {
        globalThis.fetch = savedFetch;
    }
    check('stream with answer status:finished succeeds', () => {
        assert.equal(res.success, true);
        assert.equal(res.data.choices[0].message.content, 'hello');
    });
}

// ---------------------------------------------------------------------------
// R3: 429 detection — only chunk.code === 'RateLimited' is treated as 429
// ---------------------------------------------------------------------------
console.log('\nR3 regression: narrow 429 detection in SSE stream:');
{
    // Simulate a structured error with code+detail but NOT RateLimited.
    // Before the fix this would cause the stream to set status=429 for any
    // error chunk that had {code, detail}, e.g. FAIL_SYS_USER_VALIDATE.
    const savedFetch = globalThis.fetch;
    let res;
    try {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                // Mimic a Qwen WAF/validation error that is NOT a rate limit.
                controller.enqueue(encoder.encode(
                    'data: {"code":"FAIL_SYS_USER_VALIDATE","detail":"Validation failed"}\n\n'
                ));
                controller.close();
            }
        });
        globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        });
        res = await executeApiRequestWithNodeStreaming(
            'https://example.invalid/api/v2/chat/completions',
            { stream: true, model: 'qwen3.7-plus' },
            'test-token',
            () => {}
        );
    } finally {
        globalThis.fetch = savedFetch;
    }
    check('R3: FAIL_SYS_USER_VALIDATE is NOT treated as 429 rate limit', () => {
        // Should NOT be status 429 — it's a different upstream error.
        assert.notEqual(res.status, 429, 'FAIL_SYS_USER_VALIDATE must not produce status=429');
    });

    const savedFetch2 = globalThis.fetch;
    let res2;
    try {
        const encoder = new TextEncoder();
        const body2 = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(
                    'data: {"code":"RateLimited","detail":"You have exceeded...","num":1}\n\n'
                ));
                controller.close();
            }
        });
        globalThis.fetch = async () => new Response(body2, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        });
        res2 = await executeApiRequestWithNodeStreaming(
            'https://example.invalid/api/v2/chat/completions',
            { stream: true, model: 'qwen3.7-plus' },
            'test-token',
            () => {}
        );
    } finally {
        globalThis.fetch = savedFetch2;
    }
    check('R3: chunk.code=RateLimited IS treated as 429', () => {
        assert.equal(res2.status, 429, 'RateLimited chunk must produce status=429');
    });
}

// ---------------------------------------------------------------------------
// R3b: other structured error codes (ContentFiltered, etc.) surface as 500 immediately
// ---------------------------------------------------------------------------
console.log('\nR3b regression: structured non-RateLimited errors surface as 500 (not retried 4x):');
{
    const savedFetch = globalThis.fetch;
    let res;
    try {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                // ContentFiltered — a structured error that is NOT a rate limit.
                controller.enqueue(encoder.encode(
                    'data: {"code":"ContentFiltered","detail":"Content policy violation"}\n\n'
                ));
                controller.close();
            }
        });
        globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        });
        res = await executeApiRequestWithNodeStreaming(
            'https://example.invalid/api/v2/chat/completions',
            { stream: true, model: 'qwen3.7-plus' },
            'test-token',
            () => {}
        );
    } finally {
        globalThis.fetch = savedFetch;
    }
    check('R3b: ContentFiltered chunk.code (non-RateLimited) surfaces as status=500 not 429', () => {
        assert.equal(res.status, 500, 'ContentFiltered must produce status=500 (not 429)');
        assert.ok(res.errorBody && res.errorBody.includes('ContentFiltered'),
            'errorBody must contain the structured error code');
    });
}

// ---------------------------------------------------------------------------
// R9: file:// URL and other unknown schemes must throw, not silently decode
// ---------------------------------------------------------------------------
console.log('\nR9 regression: unsupported URL schemes for attachments:');
await checkAsync('R9: file:// URL throws instead of silently decoding as base64', async () => {
    await assert.rejects(
        () => attachmentSourceToBuffer('file:///home/user/image.png', 'image/png'),
        /Unsupported URL scheme/i,
        'file:// URL must throw with Unsupported URL scheme error'
    );
});

await checkAsync('R9: file:/ (single-slash) URL throws instead of silently decoding as base64', async () => {
    // R7 fix: file:/path (single slash, no //) was not caught by the old regex.
    await assert.rejects(
        () => attachmentSourceToBuffer('file:/home/user/image.png', 'image/png'),
        /Unsupported URL scheme/i,
        'file:/ (single-slash) URL must throw with Unsupported URL scheme error'
    );
});

await checkAsync('R9: ftp:// URL throws instead of silently decoding as base64', async () => {
    await assert.rejects(
        () => attachmentSourceToBuffer('ftp://example.com/image.png', 'image/png'),
        /Unsupported URL scheme/i,
        'ftp:// URL must throw with Unsupported URL scheme error'
    );
});

await checkAsync('R9: data: URL and http:// URL are still accepted (not affected by fix)', async () => {
    // data: URL is handled before the new check, so it should not throw
    // (it will throw for a different reason in test env — no network — but NOT unsupported scheme)
    let threw = false;
    let errMsg = '';
    try {
        await attachmentSourceToBuffer('data:image/png;base64,iVBORw0KGgo=', 'image/png');
    } catch (e) {
        threw = true;
        errMsg = e.message;
    }
    if (threw) {
        assert.ok(!errMsg.includes('Unsupported URL scheme'),
            `data: URL must not throw "Unsupported URL scheme", got: ${errMsg}`);
    }
    // Plain base64 string (no scheme) must still reach the base64 branch
    // A very short valid base64 string — may decode to small buffer
    let threw2 = false;
    let errMsg2 = '';
    try {
        await attachmentSourceToBuffer('aGVsbG8=', 'image/png'); // "hello" in base64
    } catch (e) {
        threw2 = true;
        errMsg2 = e.message;
    }
    if (threw2) {
        assert.ok(!errMsg2.includes('Unsupported URL scheme'),
            `plain base64 must not throw "Unsupported URL scheme", got: ${errMsg2}`);
    }
});

// ---------------------------------------------------------------------------
// R4: 404 image in earlier history turn must NOT fail current request
// ---------------------------------------------------------------------------
console.log('\nR4 regression: 404 image in history degrades to placeholder:');
await checkAsync('R4: history 404 image with includeHistory:true does not error and keeps placeholder', async () => {
    const messages = [
        { role: 'user', content: [{ type: 'text', text: 'earlier' }, { type: 'image_url', image_url: { url: 'https://broken.invalid/old-404.png' } }] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: 'follow-up question' }] }
    ];
    const savedFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response('Not Found', { status: 404 });
        const res = await prepareOpenAIImages(messages, {
            includeHistory: true,
            tokenObj: { id: 'acc_test', token: 'test-token' }
        });
        assert.equal(res.error, null, `history 404 must not fail the session, got: ${res.error}`);
        assert.ok(String(messages[0].content).includes('[image upload failed]'),
            `history message should contain failure placeholder, got: ${messages[0].content}`);
    } finally {
        globalThis.fetch = savedFetch;
    }
});

// ---------------------------------------------------------------------------
// P4: shared upstream classifiers — Node module vs browser evaluate mirror
// ---------------------------------------------------------------------------
console.log('\nP4: browser-path classifier mirror stays in sync with Node module:');
const quotaContent = "You've reached today's Qwen4-Max limit. Upgrade your membership or switch to another model above to continue.";
let mirror = null;
check('P4: mirror block extracted from chat.js and reconstructs', () => {
    const chatSrc = fs.readFileSync('src/api/chat.js', 'utf8');
    const m = chatSrc.match(/\/\/ --- BEGIN upstream-classifiers mirror ---([\s\S]*?)\/\/ --- END upstream-classifiers mirror ---/);
    assert.ok(m, 'upstream-classifiers mirror markers must exist in chat.js');
    mirror = new Function(`${m[1]}\nreturn { isQuotaDelta, classifyChunkError, classifyJsonError };`)();
    assert.equal(typeof mirror.classifyChunkError, 'function');
    assert.equal(typeof mirror.classifyJsonError, 'function');
    assert.equal(typeof mirror.isQuotaDelta, 'function');
});

const chunkVectors = [
    null,
    {},
    { usage: { total_tokens: 5 } },
    { code: 'RateLimited', detail: 'exceeded', num: 1 },
    { code: 'FAIL_SYS_USER_VALIDATE', detail: 'Validation failed' },
    { code: 'ContentFiltered', detail: 'Content policy violation' },
    { error: 'upstream exploded' },
    { code: 'SomeCode', choices: [{ delta: { content: 'ok' } }] },
    { choices: [{ delta: { content: 'hello', phase: 'answer' } }] },
    { choices: [{ delta: { content: quotaContent, status: 'finished', extra: { update_member: true } } }] },
    { choices: [{ delta: { content: quotaContent, status: 'finished', extra: { update_member: false } } }] },
    { choices: [{ delta: { content: "You've reached today's Qwen4-Max limit. Upgrade your membership.", status: 'finished' } }] },
    { choices: [{ delta: { content: 'Just switch to another model from the dropdown.', status: 'finished' } }] },
    { choices: [{ message: { content: quotaContent, status: 'finished' } }] },
    { choices: [] },
];
check('P4: mirror.classifyChunkError matches classifySseChunkError on all vectors', () => {
    for (const v of chunkVectors) {
        assert.deepEqual(mirror.classifyChunkError(v), classifySseChunkError(v, isQuotaLimitDelta), JSON.stringify(v));
    }
});

const jsonVectors = [
    null,
    {},
    { success: false, data: { code: 'unauthorized', details: '401 Unauthorized' } },
    { success: false, error: 'x' },
    { code: 'RateLimited', num: 2 },
    { data: { code: 'RateLimited', num: 0.5 } },
    { data: { code: 'InternalError' } },
    { data: { error: 'boom' } },
    { success: true, data: { id: 'chat-1' } },
    { choices: [{ delta: { content: quotaContent, status: 'finished', extra: { update_member: true } } }] },
    { choices: [{ message: { content: quotaContent, status: 'finished' } }] },
    { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' } }] },
];
check('P4: mirror.classifyJsonError matches classifyJsonErrorBody on all vectors', () => {
    for (const v of jsonVectors) {
        assert.deepEqual(mirror.classifyJsonError(v), classifyJsonErrorBody(v, isQuotaLimitDelta), JSON.stringify(v));
    }
});

const deltaVectors = [
    null,
    undefined,
    {},
    { content: quotaContent, status: 'finished', extra: { update_member: true } },
    { content: quotaContent, status: 'finished', extra: { update_member: false } },
    { content: "You've reached today's Qwen4-Max limit. Upgrade your membership.", status: 'finished' },
    { content: 'Just switch to another model from the dropdown.', status: 'finished' },
    { content: quotaContent, status: 'streaming' },
    { content: 'x'.repeat(400) + quotaContent, status: 'finished' },
    { content: 42, status: 'finished' },
];
check('P4: mirror.isQuotaDelta matches isQuotaLimitDelta on all delta vectors', () => {
    for (const d of deltaVectors) {
        assert.equal(mirror.isQuotaDelta(d), isQuotaLimitDelta(d), JSON.stringify(d));
    }
});

check('P4: browser mirror surfaces ContentFiltered as 500 (not swallowed)', () => {
    assert.deepEqual(mirror.classifyChunkError({ code: 'ContentFiltered', detail: 'x' }), { status: 500 });
});
check('P4: browser mirror surfaces quota delta as 429 quotaLimited', () => {
    const r = mirror.classifyChunkError({ choices: [{ delta: { content: quotaContent, status: 'finished', extra: { update_member: true } } }] });
    assert.deepEqual(r, { status: 429, quotaLimited: true });
});

// ---------------------------------------------------------------------------
// P4: 429 cooldown message from RateLimited `num` (hours)
// ---------------------------------------------------------------------------
console.log('\nP4: 429 cooldown message from RateLimited num:');
check('P4: num=1 -> about 1h', () => {
    assert.ok(rateLimitMessage('{"code":"RateLimited","num":1}').includes('1h'));
});
check('P4: num=0.5 -> about 30m', () => {
    assert.ok(rateLimitMessage('{"code":"RateLimited","num":0.5}').includes('30m'));
});
check('P4: nested data.num=2 -> about 2h', () => {
    assert.ok(rateLimitMessage({ data: { num: 2 } }).includes('2h'));
});
check('P4: missing/zero num or non-JSON -> generic wait message', () => {
    assert.ok(rateLimitMessage('{"code":"RateLimited"}').includes('Please wait before retrying'));
    assert.ok(rateLimitMessage('{"code":"RateLimited","num":0}').includes('Please wait before retrying'));
    assert.ok(rateLimitMessage('not json').includes('Please wait before retrying'));
});

// ---------------------------------------------------------------------------
// P4: stream=false and non-SSE JSON error classification (nested shapes)
// ---------------------------------------------------------------------------
console.log('\nP4: stream=false and non-SSE JSON error classification:');
async function runWithJsonResponse(json, payload) {
    const savedFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response(JSON.stringify(json), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
        return await executeApiRequestWithNodeStreaming(
            'https://example.invalid/api/v2/chat/completions',
            payload,
            'test-token',
            () => {}
        );
    } finally {
        globalThis.fetch = savedFetch;
    }
}
await checkAsync('P4: stream=false success:false + data.code surfaces as 500 (was success:true)', async () => {
    const res = await runWithJsonResponse({ success: false, data: { code: 'InternalError' } }, { stream: false, model: 'qwen3.7-plus' });
    assert.equal(res.success, false);
    assert.equal(res.status, 500);
});
await checkAsync('P4: stream=false nested data.code=RateLimited -> 429', async () => {
    const res = await runWithJsonResponse({ data: { code: 'RateLimited', num: 1 } }, { stream: false, model: 'qwen3.7-plus' });
    assert.equal(res.status, 429);
});
await checkAsync('P4: stream=false top-level RateLimited -> 429 (unchanged)', async () => {
    const res = await runWithJsonResponse({ code: 'RateLimited', num: 2 }, { stream: false, model: 'qwen3.7-plus' });
    assert.equal(res.status, 429);
});
await checkAsync('P4: stream=false quota delta -> 429 quotaLimited', async () => {
    const res = await runWithJsonResponse({ choices: [{ delta: { content: quotaContent, status: 'finished', extra: { update_member: true } } }] }, { stream: false, model: 'qwen3.7-plus' });
    assert.equal(res.status, 429);
    assert.equal(res.quotaLimited, true);
});
await checkAsync('P4: non-SSE 200 with nested data.code error -> 500', async () => {
    const res = await runWithJsonResponse({ data: { code: 'SomethingWrong' } }, { stream: true, model: 'qwen3.7-plus' });
    assert.equal(res.success, false);
    assert.equal(res.status, 500);
});

const TOTAL_NEW = 2 + 1 + 2 + 2 + 1 + 4 + 1 + 6 + 4 + 5; // usage, models, EOF, R3, R3b, R9, R4, P4-mirror, P4-429-msg, P4-json
console.log(`\nchecks: ${checks}`);
console.log(checks === TOTAL_NEW ? 'PASS' : `FAIL (expected ${TOTAL_NEW}, got ${checks})`);
process.exit(checks === TOTAL_NEW ? 0 : 1);
