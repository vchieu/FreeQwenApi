import puppeteer from 'puppeteer';

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const pages = (await browser.pages()).filter(p => p.url().includes('chat.qwen.ai'));
// Prefer a real chat URL (created by a human-like UI message) over root tabs.
const keep = pages.find(p => /\/c\//.test(p.url())) || pages[0];
for (const page of pages) {
    if (page !== keep) {
        console.log('closing', page.url());
        await page.close();
    }
}
console.log('keeping', keep.url());
browser.disconnect();
