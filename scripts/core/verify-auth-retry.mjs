// Offline checks for 401 recovery decisions. No browser or network needed.
import assert from 'node:assert/strict';
import {
    isUnauthorizedResult,
    isUsableRefreshedToken,
    pickProxyOwnedQwenPage
} from '../../src/api/authRecovery.js';

let checks = 0;
function check(name, fn) {
    fn();
    checks++;
    console.log(`  ok - ${name}`);
}

const now = Date.now();
const jwt = (expSec) => {
    const header = Buffer.from('{"alg":"none"}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: 'acc_test', exp: expSec })).toString('base64url');
    return `${header}.${payload}.sig`;
};
const expired = jwt(Math.floor((now - 60_000) / 1000));
const fresh = jwt(Math.floor((now + 15 * 60_000) / 1000));
const almostExpired = jwt(Math.floor((now + 10_000) / 1000));

console.log('401 detection:');
check('HTTP 401 is unauthorized', () => {
    assert.equal(isUnauthorizedResult({ status: 401 }), true);
});
check('HTTP 200 with unauthorized body is unauthorized', () => {
    assert.equal(isUnauthorizedResult({ data: { code: 'unauthorized', details: '401 Unauthorized' } }), true);
});
check('successful body is not unauthorized', () => {
    assert.equal(isUnauthorizedResult({ status: 200, data: { success: true } }), false);
});

console.log('Refreshed token selection:');
check('fresh token differing from failed token is usable', () => {
    assert.equal(isUsableRefreshedToken(fresh, expired, now), true);
});
check('expired token is rejected even when different', () => {
    assert.equal(isUsableRefreshedToken(expired, fresh, now), false);
});
check('the exact rejected token is never retried', () => {
    assert.equal(isUsableRefreshedToken(fresh, fresh, now), false);
});
check('token expiring within skew is rejected', () => {
    assert.equal(isUsableRefreshedToken(almostExpired, expired, now), false);
});

console.log('Proxy-owned page selection:');
const userTab = { url: () => 'https://chat.qwen.ai/c/human', isClosed: () => false };
const baseTab = { url: () => 'https://chat.qwen.ai/', isClosed: () => false };
const poolTab = { url: () => 'https://chat.qwen.ai/c/proxy', isClosed: () => false };
const closedTab = { url: () => 'https://chat.qwen.ai/c/closed', isClosed: () => true };
check('prefers pooled proxy tab over base and human tab', () => {
    assert.equal(pickProxyOwnedQwenPage([userTab, baseTab, poolTab], baseTab, [poolTab]), poolTab);
});
check('never picks the human tab', () => {
    assert.equal(pickProxyOwnedQwenPage([userTab], baseTab, [poolTab]), null);
});
check('skips closed tabs', () => {
    assert.equal(pickProxyOwnedQwenPage([closedTab, baseTab], baseTab, [poolTab]), baseTab);
});

const TOTAL = 3 + 4 + 3;
console.log(`\nchecks: ${checks}`);
console.log(checks === TOTAL ? 'PASS' : `FAIL (expected ${TOTAL} checks, got ${checks})`);
process.exit(checks === TOTAL ? 0 : 1);
