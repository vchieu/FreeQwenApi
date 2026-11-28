import fs from 'node:fs';
import puppeteer from 'puppeteer';

function decode(token) {
    try {
        const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        return { id: p.id, exp: p.exp, iat: p.iat, expDate: new Date(p.exp * 1000).toISOString() };
    } catch (e) { return { error: e.message }; }
}

const storedPath = 'session/auth_token.txt';
if (fs.existsSync(storedPath)) {
    const t = fs.readFileSync(storedPath, 'utf8').trim();
    console.log('STORED auth_token.txt:', t ? decode(t) : '(empty)');
} else {
    console.log('STORED auth_token.txt: (missing)');
}

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const page = (await browser.pages()).find(p => p.url().includes('chat.qwen.ai'));
const data = await page.evaluate(() => {
    const out = { token: localStorage.getItem('token') };
    try { out.state = JSON.parse(localStorage.getItem('qwen_access_token_state') || '{}').token; } catch {}
    out.expire = localStorage.getItem('at_expire_time');
    return out;
});
console.log('BROWSER token:', decode(data.token));
if (data.state) console.log('BROWSER state token:', decode(data.state));
console.log('BROWSER at_expire_time:', data.expire, data.expire ? new Date(Number(data.expire)).toISOString() : '');
console.log('FULL_BROWSER_TOKEN=' + data.token);
browser.disconnect();
