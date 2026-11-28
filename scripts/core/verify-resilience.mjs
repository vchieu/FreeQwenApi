// Offline checks for transient network retry + captcha notification plumbing.
// No browser, network or notification process is started.
import assert from 'node:assert/strict';
import {
    CAPTCHA_NOTICE,
    isRetryableNetworkError,
    shouldRetryNetworkError,
    detectCaptchaSignal,
    isCaptchaResponse,
    isChatInProgress,
    isProtocolTimeoutError,
    isNodeStreamTimeout,
    isVisibleBox,
    nonStreamErrorBody,
    formatRateLimitCooldown,
    applyRetryReasoningSuppression
} from '../../src/api/resilience.js';
import { notificationCommand } from '../../src/utils/notify.js';

let checks = 0;
function check(name, fn) {
    fn();
    checks++;
    console.log(`  ok - ${name}`);
}

console.log('Network error detection:');
check('browser fetch TypeError is retryable', () => {
    assert.equal(isRetryableNetworkError({ success: false, error: 'TypeError: network error' }), true);
});
check('node fetch failure is retryable', () => {
    assert.equal(isRetryableNetworkError({ success: false, error: 'TypeError: fetch failed' }), true);
});
check('socket hang up is retryable', () => {
    assert.equal(isRetryableNetworkError({ error: 'Error: socket hang up' }), true);
});
check('HTTP 500 is not a network retry', () => {
    assert.equal(isRetryableNetworkError({ status: 500, errorBody: 'oops' }), false);
});
check('partially streamed answer is never replayed', () => {
    assert.equal(isRetryableNetworkError({ error: 'TypeError: network error', hasStreamedChunks: true }), false);
});
check('captcha response is not treated as a network error', () => {
    assert.equal(isRetryableNetworkError({ captcha: true, error: 'network error' }), false);
});
check('retry budget is respected', () => {
    assert.equal(shouldRetryNetworkError({ error: 'network error' }, 2, 3), true);
    assert.equal(shouldRetryNetworkError({ error: 'network error' }, 3, 3), false);
});

console.log('Captcha signal detection:');
check('WAF report URL is detected', () => {
    assert.equal(detectCaptchaSignal({ url: 'https://chat.qwen.ai/_____tmd_____/report?x=1' }), 'slider');
});
check('slider captcha DOM marker is detected', () => {
    assert.equal(detectCaptchaSignal({ text: 'Please slide nc_1_nocaptcha to verify' }), 'slider');
});
check('Verification page title is detected', () => {
    assert.equal(detectCaptchaSignal({ title: 'Verification - Qwen' }), 'verification');
});
check('Chinese slider marker is detected', () => {
    assert.equal(detectCaptchaSignal({ text: '请完成安全验证后继续' }), 'slider');
});
check('plain chat page is not a captcha', () => {
    assert.equal(detectCaptchaSignal({ url: 'https://chat.qwen.ai/c/abc', title: 'Qwen', text: 'Hello there' }), null);
});
check('captcha HTML in an upstream error is recognized', () => {
    assert.equal(isCaptchaResponse({ errorBody: '<html>Verification required</html>' }), true);
});
check('notice tells the user what to do', () => {
    assert.match(CAPTCHA_NOTICE, /resolve captcha/i);
});
check('hidden captcha iframe (0x0) is not an active captcha', () => {
    // Qwen leaves a 0x0 baxia-dialog-content iframe after the slider is solved.
    assert.equal(isVisibleBox(null), false);
    assert.equal(isVisibleBox({ width: 0, height: 0 }), false);
    assert.equal(isVisibleBox({ width: 120, height: 80 }), true);
});

console.log('Qwen CHAT_IN_PROGRESS recovery:');
check('500 CHAT_IN_PROGRESS body is recognized', () => {
    assert.equal(isChatInProgress({ status: 500, errorBody: '{"success":false,"data":{"code":"CHAT_IN_PROGRESS","details":"The chat is in progress!"}}' }), true);
});
check('ordinary 500 is not misclassified', () => {
    assert.equal(isChatInProgress({ status: 500, errorBody: '{"data":{"code":"Internal_Server_Error"}}' }), false);
});

console.log('Puppeteer protocol timeout detection:');
check('Runtime.callFunctionOn timeout is recognized', () => {
    assert.equal(isProtocolTimeoutError({
        success: false,
        error: 'ProtocolError: Runtime.callFunctionOn timed out. Increase the \'protocolTimeout\' setting in launch/connect calls for a higher timeout if needed.'
    }), true);
});
check('closed CDP target is recognized', () => {
    assert.equal(isProtocolTimeoutError({ error: 'TargetCloseError: Protocol error (Runtime.callFunctionOn): Target closed' }), true);
});
check('ordinary errors and partial streams are not protocol timeouts', () => {
    assert.equal(isProtocolTimeoutError({ error: 'TypeError: network error' }), false);
    assert.equal(isProtocolTimeoutError({ status: 500, errorBody: 'oops' }), false);
    assert.equal(isProtocolTimeoutError({ error: 'Runtime.callFunctionOn timed out', hasStreamedChunks: true }), false);
    assert.equal(isProtocolTimeoutError({ captcha: true, error: 'Runtime.callFunctionOn timed out' }), false);
});

console.log('Node fetch timeout detection:');
check('AbortSignal.timeout on node stream is recognized', () => {
    assert.equal(isNodeStreamTimeout({ nodeTimeout: true, error: 'TimeoutError: The operation was aborted due to timeout' }), true);
});
check('ordinary network errors and partial streams are not node timeouts', () => {
    assert.equal(isNodeStreamTimeout({ error: 'TypeError: network error' }), false);
    assert.equal(isNodeStreamTimeout({ nodeTimeout: true, hasStreamedChunks: true }), false);
    assert.equal(isNodeStreamTimeout({ nodeTimeout: true, status: 500 }), false);
    assert.equal(isNodeStreamTimeout({ nodeTimeout: true, captcha: true }), false);
});

console.log('Desktop notification commands:');
const win = notificationCommand('win32', 'FreeQwenApi', CAPTCHA_NOTICE);
check('Windows uses PowerShell with the message', () => {
    assert.equal(win.cmd, 'powershell.exe');
    assert.equal(win.args[1], '-Command');
    assert.match(win.args[2], /MessageBox/);
    assert.match(win.args[2], /resolve captcha/i);
    assert.ok(!win.args.includes('-NonInteractive'));
});
const mac = notificationCommand('darwin', 'FreeQwenApi', CAPTCHA_NOTICE);
check('macOS uses osascript display notification', () => {
    assert.equal(mac.cmd, 'osascript');
    assert.match(mac.args[1], /display notification/);
});
const linux = notificationCommand('linux', 'FreeQwenApi', CAPTCHA_NOTICE);
check('Linux uses notify-send', () => {
    assert.equal(linux.cmd, 'notify-send');
    assert.match(linux.args[1], /resolve captcha/i);
});
check('quotes are stripped from notification text', () => {
    const spec = notificationCommand('darwin', 'A"B', "it's fine");
    assert.doesNotMatch(spec.args[1], /["']{2}/);
});
check('unsupported platform is a no-op', () => {
    assert.equal(notificationCommand('freebsd', 'title', 'message'), null);
});

console.log('Node stream early failure:');
const {
    executeApiRequestWithNodeStreaming,
    recordBrowserTokenRateLimit,
    getRateLimitCooldownError,
    clearBrowserTokenRateLimits
} = await import('../../src/api/chat.js');
const savedFetch = globalThis.fetch;
let earlyFailure;
try {
    globalThis.fetch = async () => { throw new TypeError('network error'); };
    earlyFailure = await executeApiRequestWithNodeStreaming(
        'https://example.invalid/api/v2/chat/completions',
        { stream: true, model: 'test' },
        'test-token',
        null
    );
} finally {
    globalThis.fetch = savedFetch;
}
check('early fetch failure returns a structured result (no ReferenceError)', () => {
    assert.equal(earlyFailure.success, false);
    assert.equal(earlyFailure.hasStreamedChunks, false);
    assert.equal(earlyFailure.hasStreamedReasoning, false);
    assert.equal(earlyFailure.nodeTimeout, false);
    assert.match(earlyFailure.error, /network error/);
});

console.log('Thinking retry deduplication & 429 propagation:');
{
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        async pull(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"THOUGHT-1","phase":"thinking"}}]}\n\n'));
            await new Promise(r => setTimeout(r, 10));
            controller.error(new TypeError('network error mid-stream'));
        }
    });
    const saved = globalThis.fetch;
    let midFail;
    const thoughts = [];
    try {
        globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        });
        midFail = await executeApiRequestWithNodeStreaming(
            'https://example.invalid/api/v2/chat/completions',
            { stream: true, model: 'test' },
            'test-token',
            null,
            (t) => thoughts.push(t)
        );
    } finally {
        globalThis.fetch = saved;
    }
    check('catch path after reasoning streamed sets hasStreamedReasoning=true and suppresses retry onReasoning', () => {
        assert.equal(midFail.success, false);
        assert.deepEqual(thoughts, ['THOUGHT-1']);
        assert.equal(midFail.hasStreamedReasoning, true);
        const retryOpts = applyRetryReasoningSuppression({ onReasoning: () => {} }, midFail);
        assert.equal(retryOpts.onReasoning, null);
    });
}

check('nonStreamErrorBody propagates 429 status instead of defaulting to 500', () => {
    const out = nonStreamErrorBody({ error: 'Rate limited', status: 429 });
    assert.equal(out.status, 429);
    assert.equal(out.body.error.type, 'rate_limit_error');
    const fallback = nonStreamErrorBody({ error: 'Boom' });
    assert.equal(fallback.status, 500);
});

check('tab-only browser token 429 cooldown is reported instead of Auth error', () => {
    clearBrowserTokenRateLimits();
    try {
        recordBrowserTokenRateLimit('browser-only-jwt', Date.now() + 30 * 60 * 1000);
        const msg = getRateLimitCooldownError();
        assert.ok(msg && /Rate limited:/i.test(msg), `expected Rate limited cooldown message, got: ${msg}`);
        assert.equal(formatRateLimitCooldown(Date.now() - 1000), null);
    } finally {
        clearBrowserTokenRateLimits();
    }
});

const TOTAL = 7 + 8 + 2 + 3 + 2 + 5 + 1 + 3;
console.log(`\nchecks: ${checks}`);
console.log(checks === TOTAL ? 'PASS' : `FAIL (expected ${TOTAL} checks, got ${checks})`);
process.exit(checks === TOTAL ? 0 : 1);
