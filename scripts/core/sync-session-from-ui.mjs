import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const root = process.cwd();

// 1. Baxia headers from the just-captured real UI request.
const captured = JSON.parse(fs.readFileSync(path.join(root, 'session', 'ui-full-capture.json'), 'utf8'))
    .find(r => r.url.includes('chat/completions'));
if (!captured) throw new Error('No completions request captured');
fs.writeFileSync(path.join(root, 'session', 'baxia.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    url: captured.url,
    headers: captured.headers,
    postData: captured.requestBody
}, null, 2));
console.log('baxia.json updated');

// 2. Freshest access token from the browser.
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const page = (await browser.pages()).find(p => p.url().includes('chat.qwen.ai'));
if (!page) throw new Error('No Qwen tab');
const token = await page.evaluate(() => localStorage.getItem('token'));
browser.disconnect();
if (!token) throw new Error('No token in browser');

const tokensPath = path.join(root, 'session', 'tokens.json');
const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
if (!tokens.length) tokens.push({ id: 'acc_1795263808256', token, resetAt: null, invalid: false });
else {
    tokens[0].token = token;
    tokens[0].invalid = false;
    tokens[0].resetAt = null;
}
fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
console.log('tokens.json updated');
