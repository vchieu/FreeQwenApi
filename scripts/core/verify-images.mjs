// Offline fixtures for Qwen image attachment selection. No network/browser.
import assert from 'node:assert/strict';
import { collectImageParts } from '../../src/api/fileUpload.js';

let checks = 0;
function check(name, fn) {
    fn();
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

console.log(`checks: ${checks}`);
console.log('PASS');
