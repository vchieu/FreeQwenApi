// Runs on chat.qwen.ai. Reports the current short-lived access token to the
// background worker so a sync can happen even without a fresh UI message.

const POLL_MS = 30_000;
let lastToken = '';

function readToken() {
    try {
        return localStorage.getItem('token') || '';
    } catch {
        return '';
    }
}

function report(token, force = false) {
    if (!token || (!force && token === lastToken)) return;
    lastToken = token;
    try {
        chrome.runtime.sendMessage({ type: 'qwen-token', token });
    } catch {
        // The worker may not be ready yet; the next poll will retry.
    }
}

report(readToken(), true);
setInterval(() => report(readToken()), POLL_MS);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'qwen-read-token') {
        sendResponse({ token: readToken() });
        return true;
    }
});
