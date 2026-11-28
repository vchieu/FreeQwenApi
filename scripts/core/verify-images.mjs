// Offline fixtures for Qwen image attachment selection. No network/browser.
import assert from 'node:assert/strict';
import { collectImageParts, attachmentSourceToBuffer, prepareOpenAIImages } from '../../src/api/fileUpload.js';

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

const img = (url) => ({ type: 'image_url', image_url: { url } });
const text = (value) => ({ type: 'text', text: value });

// Regression: a follow-up request carries earlier turns with images. Those
// images must NOT be re-uploaded (that duplicated every image in Qwen chat).
check('only the last user turn is uploaded', () => {
    const messages = [
        { role: 'user', content: [text('old question'), img('data:image/png;base64,OLD')] },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: [text('new question'), img('data:image/png;base64,NEW')] }
    ];
    const { currentParts, touchedMessages, currentMessage } = collectImageParts(messages);
    assert.equal(currentParts.length, 1);
    assert.equal(currentParts[0].source, 'data:image/png;base64,NEW');
    assert.equal(currentMessage, messages[2]);
    assert.equal(touchedMessages.size, 2);
});

check('old image parts are replaced with a short placeholder', () => {
    const messages = [
        { role: 'user', content: [text('old'), img('data:image/png;base64,OLD')] },
        { role: 'user', content: [text('new'), img('data:image/png;base64,NEW')] }
    ];
    collectImageParts(messages);
    assert.equal(messages[0].content.length, 2);
    assert.deepEqual(messages[0].content[1], { type: 'text', text: '[image]' });
    assert.ok(!JSON.stringify(messages[0].content).includes('OLD'));
});

check('duplicate image sources in the current turn are uploaded once', () => {
    const messages = [{ role: 'user', content: [img('https://example.test/a.png'), img('https://example.test/a.png')] }];
    const { currentParts } = collectImageParts(messages);
    assert.equal(currentParts.length, 1);
    assert.equal(messages[0].content.length, 1);
});

check('messages without images are untouched', () => {
    const messages = [
        { role: 'user', content: 'plain string' },
        { role: 'assistant', content: [text('answer')] }
    ];
    const { currentParts, touchedMessages } = collectImageParts(messages);
    assert.equal(currentParts.length, 0);
    assert.equal(touchedMessages.size, 0);
    assert.deepEqual(messages[0].content, 'plain string');
});

check('system messages never contribute images', () => {
    const messages = [
        { role: 'system', content: [img('data:image/png;base64,SYSTEM')] },
        { role: 'user', content: [text('hello')] }
    ];
    const { currentParts, touchedMessages } = collectImageParts(messages);
    assert.equal(currentParts.length, 0);
    assert.equal(touchedMessages.size, 0);
});

check('includeHistory collects earlier turn images for new Qwen chats (deduped)', () => {
    const messages = [
        { role: 'user', content: [text('turn 1'), img('data:image/png;base64,IMG1')] },
        { role: 'assistant', content: 'saw it' },
        { role: 'user', content: [text('what color?')] }
    ];
    const { currentParts, touchedMessages } = collectImageParts(messages, { includeHistory: true });
    assert.equal(currentParts.length, 1);
    assert.equal(currentParts[0].source, 'data:image/png;base64,IMG1');
    assert.equal(touchedMessages.size, 1);
    assert.deepEqual(messages[0].content[1], { type: 'text', text: '[image]' });
});

check('PDF file parts are collected and labelled without [object Object]', () => {
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } },
                text('summarize')
            ]
        }
    ];
    const { currentParts } = collectImageParts(messages);
    assert.equal(currentParts.length, 1);
    assert.equal(currentParts[0].kind, 'file');
    assert.equal(currentParts[0].filename, 'report.pdf');
});

// --- Fix A regression tests: call REAL attachmentSourceToBuffer() (no fake copy) ---
console.log('\nFix A: real attachmentSourceToBuffer() classification:');

await checkAsync('JPEG raw base64 (/9j/...) is decoded by attachmentSourceToBuffer, not rejected as local path', async () => {
    const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/';
    const decoded = await attachmentSourceToBuffer(jpegBase64, 'image/jpeg');
    assert.ok(Buffer.isBuffer(decoded.buffer) && decoded.buffer.length > 0, 'JPEG base64 must decode to non-empty Buffer');
    assert.equal(decoded.buffer[0], 0xff);
    assert.equal(decoded.buffer[1], 0xd8);
});

await checkAsync('Windows path C:\\Users\\... and C:/Users/... are rejected by attachmentSourceToBuffer', async () => {
    await assert.rejects(
        () => attachmentSourceToBuffer('C:\\Users\\me\\shot.png', 'image/png'),
        /Local filesystem path/i
    );
    await assert.rejects(
        () => attachmentSourceToBuffer('C:/Users/me/shot.png', 'image/png'),
        /Local filesystem path|Unsupported URL scheme/i
    );
});

await checkAsync('Unix multi-segment path /home/user/shot.png is rejected by attachmentSourceToBuffer', async () => {
    await assert.rejects(
        () => attachmentSourceToBuffer('/home/user/shot.png', 'image/png'),
        /Local filesystem path/i
    );
    await assert.rejects(
        () => attachmentSourceToBuffer('/tmp/image.jpg', 'image/jpeg'),
        /Local filesystem path/i
    );
});

await checkAsync('file:// and file:/ URLs are rejected by attachmentSourceToBuffer', async () => {
    await assert.rejects(
        () => attachmentSourceToBuffer('file:///home/user/img.png', 'image/png'),
        /Unsupported URL scheme/i
    );
    await assert.rejects(
        () => attachmentSourceToBuffer('file:/path/img.png', 'image/png'),
        /Unsupported URL scheme/i
    );
});

await checkAsync('data: URL and http: URL are accepted and decoded by attachmentSourceToBuffer', async () => {
    const fromData = await attachmentSourceToBuffer('data:image/png;base64,iVBORw0KGgo=', 'image/png');
    assert.ok(Buffer.isBuffer(fromData.buffer) && fromData.buffer.length > 0);

    const savedFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-type': 'image/png' }
        });
        const fromHttp = await attachmentSourceToBuffer('https://example.com/img.png', 'image/png');
        assert.deepEqual([...fromHttp.buffer], [1, 2, 3, 4]);
    } finally {
        globalThis.fetch = savedFetch;
    }
});

await checkAsync('resending a failed image with includeHistory:true keeps error + placeholder (not silently dropped)', async () => {
    const brokenUrl = 'https://broken.invalid/failed.png';
    const messages = [
        { role: 'user', content: [text('turn 1'), img(brokenUrl)] },
        { role: 'assistant', content: 'failed earlier' },
        { role: 'user', content: [text('retry same image'), img(brokenUrl)] }
    ];
    const savedFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response('Not Found', { status: 404 });
        const result = await prepareOpenAIImages(messages, {
            includeHistory: true,
            tokenObj: { id: 'acc_test', token: 'test-token' }
        });
        assert.ok(result.error && result.error.includes('Attachment upload failed'),
            `expected Attachment upload failed error, got: ${result.error}`);
        assert.ok(String(messages[2].content).includes('[image upload failed]'),
            `current turn must preserve [image upload failed] placeholder, got: ${messages[2].content}`);
    } finally {
        globalThis.fetch = savedFetch;
    }
});

console.log(`checks: ${checks}`);
console.log('PASS');
