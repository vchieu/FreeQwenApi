// Offline checks for quota limit detection. No browser or network needed.
import assert from 'node:assert/strict';
import { isQuotaLimitDelta, quotaLimitMessage } from '../../src/api/quotaLimit.js';

let checks = 0;
function check(name, fn) {
    fn();
    checks++;
    console.log(`  ok - ${name}`);
}

console.log('Quota limit detection:');

check('extra.update_member === true is detected', () => {
    const delta = {
        role: 'assistant',
        content: "You've reached today's Qwen4-Max limit. Upgrade your membership or switch to another model above to continue.",
        phase: 'answer',
        status: 'finished',
        extra: { update_member: true }
    };
    assert.equal(isQuotaLimitDelta(delta), true);
});

check('extra.update_member === false is NOT detected', () => {
    const delta = {
        content: "You've reached today's Qwen4-Max limit.",
        status: 'finished',
        extra: { update_member: false }
    };
    assert.equal(isQuotaLimitDelta(delta), false);
});

check('no extra field with matching content is detected (fallback)', () => {
    const delta = {
        content: "You've reached today's Qwen4-Max limit. Upgrade your membership.",
        status: 'finished'
    };
    assert.equal(isQuotaLimitDelta(delta), true);
});

check('long content (>300 chars) is NOT detected even with matching pattern', () => {
    const longContent = "This is a very long answer that discusses the concept of limits and quotas in great detail. ".repeat(5) + 
                      "You've reached today's Qwen4-Max limit. Upgrade your membership.";
    const delta = {
        content: longContent,
        status: 'finished'
    };
    assert.equal(isQuotaLimitDelta(delta), false);
});

check('content without finished status is NOT detected', () => {
    const delta = {
        content: "You've reached today's Qwen4-Max limit.",
        status: 'streaming'
    };
    assert.equal(isQuotaLimitDelta(delta), false);
});

check('normal answer is NOT detected', () => {
    const delta = {
        content: "Here is your answer about programming.",
        status: 'finished'
    };
    assert.equal(isQuotaLimitDelta(delta), false);
});

check('null delta is NOT detected', () => {
    assert.equal(isQuotaLimitDelta(null), false);
});

check('empty delta is NOT detected', () => {
    assert.equal(isQuotaLimitDelta({}), false);
});

check('quotaLimitMessage includes model name', () => {
    const msg = quotaLimitMessage('qwen4-max');
    assert.ok(msg.includes('qwen4-max'));
    assert.ok(msg.includes('quota'));
});

console.log(`\nchecks: ${checks}`);
console.log(checks === 9 ? 'PASS' : `FAIL (expected 9 checks, got ${checks})`);
process.exit(checks === 9 ? 0 : 1);
