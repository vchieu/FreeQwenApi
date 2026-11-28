// Offline checks for account failover and retry behaviour. Runs the real chat.js,
// tokenManager.js and resilience.js; only the browser, logger and notifications are
// stubbed. Tokens are written to a temporary SESSION_DIR, never to ./session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-failover-'));
process.env.SESSION_DIR = sessionDir;
process.env.RETRY_DELAY = '1';

const hooks = `
const stub = (code) => ({ url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true });
const noop = (names) => names.map(n => 'export const ' + n + ' = () => {};').join('');
export async function resolve(spec, context, next) {
    if (spec.endsWith('/browser.js')) return stub('export const getBrowserContext = () => globalThis.__ctx;'
        + 'export const getAuthenticationStatus = () => true; export const ensureBrowserConnection = async () => true;');
    if (spec.endsWith('browser/auth.js')) return stub('export const checkAuthentication = async () => true; export const checkVerification = async () => false;');
    if (spec.endsWith('browser/session.js')) return stub(noop(['saveAuthToken', 'saveSession']));
    if (spec.endsWith('utils/notify.js')) return stub(noop(['sendDesktopNotification']));
    if (spec.endsWith('logger/index.js')) return stub(noop(['logInfo', 'logError', 'logWarn', 'logDebug', 'logRaw', 'logHttpRequest']));
    return next(spec, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));

// --- fake browser tab ------------------------------------------------------

let tabToken = null;
let browserPosts = 0;
let creates = [];
let createReply = () => created('chat');
const created = (id) => ({ success: true, data: { success: true, data: { id } } });

const page = {
    url: () => 'https://chat.qwen.ai/c/human',
    isClosed: () => false,
    reload: async () => {},
    goto: async () => {},
    title: async () => '',
    frames: () => [],
    $: async () => null,
    createCDPSession: async () => ({ send: async () => ({ cookies: [] }), detach: async () => {} }),
    evaluate: async (fn, arg) => {
        const source = String(fn);
        if (arg?.apiUrl?.includes('chats/new')) {
            creates.push(who(arg.token));
            return createReply(who(arg.token));
        }
        if (arg?.payload) {
            browserPosts++;
            return { success: false, status: 500, errorBody: '{"data":{"code":"CHAT_IN_PROGRESS"}}' };
        }
        if (source.includes("localStorage.getItem('token')") && source.length < 80) return tabToken;
        if (source.includes('readyState')) return 'complete';
        if (source.includes('querySelector(selector)')) return true;
        return null;
    }
};
globalThis.__ctx = {
    browser: () => ({ pages: async () => [page] }),
    newPage: async () => ({ goto: async () => {}, evaluate: async () => tabToken, close: async () => {} })
};

const { sendMessage, clearBrowserTokenRateLimits } = await import('../../src/api/chat.js');
const { formatRateLimitCooldown } = await import('../../src/api/resilience.js');

// --- helpers ---------------------------------------------------------------

function jwt(id, ttlSeconds = 900) {
    const payload = Buffer.from(JSON.stringify({ id, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
    return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}
function who(token) {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).id;
}
const tokensFile = path.join(sessionDir, 'tokens.json');
const stored = () => Object.fromEntries(JSON.parse(fs.readFileSync(tokensFile, 'utf8')).map(t => [who(t.token), t]));
const cooldownHours = (entry) => entry.resetAt ? Math.round((Date.parse(entry.resetAt) - Date.now()) / 3_600_000) : 0;

const sse = (chunks) => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const delta = (d) => ({ choices: [{ delta: d }] });
const thinkThenOk = (t) => sse([delta({ phase: 'think', content: t }), delta({ phase: 'answer', content: 'ok', status: 'finished' })]);
const status = (code) => new Response(JSON.stringify({ code: code === 429 ? 'RateLimited' : 'Unauthorized', num: 5 }), { status: code });

let sends = [];
let reply = () => thinkThenOk('THOUGHT ');
globalThis.fetch = async (url, init) => {
    const account = who(init.headers.Authorization.slice(7));
    sends.push({ account, chatId: JSON.parse(init.body).chat_id });
    return reply(account, sends.length);
};

let thinking = '';
function setup(accounts, { tab = null } = {}) {
    fs.writeFileSync(tokensFile, JSON.stringify(accounts));
    clearBrowserTokenRateLimits();
    tabToken = tab;
    browserPosts = 0;
    creates = [];
    sends = [];
    thinking = '';
    createReply = (id) => created(`chat-${id}`);
    reply = () => thinkThenOk('THOUGHT ');
}
const send = (tokenObj) => sendMessage('hi', 'qwen3.7-plus', null, null, [], null, null, null, 't2t', null, true, 0, null,
    { collectOnly: true, tokenObj: { ...tokenObj }, onReasoning: (t) => { thinking += t; } });

let checks = 0;
async function check(name, fn) {
    await fn();
    checks++;
    console.log(`  ok - ${name}`);
}

const accountA = () => ({ id: 'acc_a', token: jwt('userA') });
const accountB = (ttl) => ({ id: 'acc_b', token: jwt('userB', ttl) });
const rateLimitA = (id) => id === 'userA'
    ? { success: false, status: 429, errorBody: '{"code":"RateLimited","num":2}' }
    : created(`chat-${id}`);

// --- account switch at chat creation ---------------------------------------

console.log('429 at chat creation:');
await check('429 on send is recorded on the account that sent, not the one that failed createChat', async () => {
    const a = accountA();
    setup([a, accountB()]);
    createReply = rateLimitA;
    reply = () => status(429);
    const result = await send(a);
    assert.deepEqual(sends.map(s => s.account), ['userB']);
    assert.equal(result.status, 429);
    assert.equal(cooldownHours(stored().userA), 2, 'first account keeps its own cooldown');
    assert.equal(cooldownHours(stored().userB), 5, 'sending account is cooled down');
});

await check('401 on send after the switch invalidates only the sending account', async () => {
    const a = accountA();
    setup([a, accountB()]);
    createReply = rateLimitA;
    reply = () => status(401);
    await send(a);
    assert.equal(stored().userB.invalid, true);
    assert.notEqual(stored().userA.invalid, true, 'rate-limited account must stay valid');
});

await check('only an expiring account left: one attempt, then a 429 cooldown error', async () => {
    const a = accountA();
    setup([a, accountB(10)]);
    createReply = rateLimitA;
    const result = await send(a);
    assert.deepEqual(creates, ['userA']);
    assert.equal(result.status, 429);
    assert.equal(sends.length, 0);
});

await check('rate-limited browser tab is not retried while the stored account is expiring', async () => {
    const a = accountA();
    setup([a, accountB(10)], { tab: a.token });
    createReply = rateLimitA;
    const result = await send({ ...a, source: 'browser' });
    assert.deepEqual(creates, ['userA']);
    assert.equal(result.status, 429);
});

console.log('401 at chat creation:');
await check('switching from the browser tab to a stored account drops source=browser', async () => {
    const tab = jwt('userT');
    setup([accountB()], { tab });
    createReply = (id) => id === 'userT' ? { success: false, status: 401, errorBody: 'Unauthorized' } : created(`chat-${id}`);
    reply = (account) => account === 'userB' ? status(401) : thinkThenOk('THOUGHT ');
    await send({ id: 'browser', token: tab, source: 'browser' });
    assert.deepEqual(sends.map(s => s.account), ['userB'], 'no replay of the stored chat under the tab account');
    assert.equal(stored().userB.invalid, true);
});

// --- thinking must reach the client once -----------------------------------

console.log('Reasoning across retries:');
await check('network error during thinking: fresh chat, no browser re-POST, thinking once', async () => {
    const a = accountA();
    setup([a]);
    reply = (account, n) => {
        if (n > 1) return thinkThenOk('THOUGHT-2 ');
        let pulls = 0;
        const bytes = new TextEncoder().encode(`data: ${JSON.stringify(delta({ phase: 'think', content: 'THOUGHT-1 ' }))}\n\n`);
        const body = new ReadableStream({ pull(c) { if (pulls++ === 0) c.enqueue(bytes); else c.error(new TypeError('terminated')); } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const result = await send(a);
    assert.equal(result.choices?.[0]?.message?.content, 'ok');
    assert.equal(browserPosts, 0);
    assert.equal(thinking, 'THOUGHT-1 ');
});

await check('in-stream RateLimited after thinking: next account does not repeat thinking', async () => {
    const a = accountA();
    setup([a, accountB()]);
    reply = (account) => account === 'userA'
        ? sse([delta({ phase: 'think', content: 'THOUGHT-1 ' }), { code: 'RateLimited', num: 1 }])
        : thinkThenOk('THOUGHT-2 ');
    const result = await send(a);
    assert.deepEqual(sends.map(s => s.account), ['userA', 'userB']);
    assert.equal(result.choices?.[0]?.message?.content, 'ok');
    assert.equal(thinking, 'THOUGHT-1 ');
});

// --- cooldown message ------------------------------------------------------

console.log('Cooldown message:');
await check('minutes roll over into hours instead of printing 60m', () => {
    const now = Date.now();
    const text = (seconds) => formatRateLimitCooldown(now + seconds * 1000, now);
    assert.match(text(4 * 3600 + 59 * 60 + 30), /in 5h 0m\./);
    assert.match(text(59 * 60 + 30), /in 1h 0m\./);
    assert.match(text(30 * 60), /in 30m\./);
});

const TOTAL = 4 + 1 + 2 + 1;
console.log(`\nchecks: ${checks}`);
console.log(checks === TOTAL ? 'PASS' : `FAIL (expected ${TOTAL} checks, got ${checks})`);
process.exit(checks === TOTAL ? 0 : 1);
