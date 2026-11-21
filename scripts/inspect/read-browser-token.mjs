import puppeteer from 'puppeteer';

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
for (const page of await browser.pages()) {
    if (!page.url().includes('chat.qwen.ai')) continue;
    const data = await page.evaluate(() => {
        const out = {};
        for (const k of Object.keys(localStorage)) {
            if (/token|auth|user|session/i.test(k)) {
                out[k] = String(localStorage.getItem(k)).slice(0, 80);
            }
        }
        return { url: location.href, keys: Object.keys(localStorage), interesting: out };
    });
    console.log(JSON.stringify(data, null, 2));
}
browser.disconnect();
