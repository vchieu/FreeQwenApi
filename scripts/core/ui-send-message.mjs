import puppeteer from 'puppeteer';

const text = process.argv[2] || 'hello';
const LIMIT = Number(process.env.UI_SEND_TIMEOUT_MS) || 25_000;

const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
]);

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
try {
    const pages = (await browser.pages()).filter(p => p.url().includes('chat.qwen.ai'));
    if (!pages.length) throw new Error('No Qwen tab found');
    const page = pages[0];
    console.log('Typing in:', page.url());

    const input = await withTimeout(
        page.waitForSelector('textarea.message-input-textarea', { timeout: 10_000 }),
        12_000,
        'waitForSelector'
    );
    await withTimeout(page.bringToFront(), 5_000, 'bringToFront');
    await withTimeout(page.focus('textarea.message-input-textarea'), 5_000, 'focus');
    await withTimeout(page.keyboard.type(text, { delay: 25 }), 10_000, 'type');
    await new Promise(r => setTimeout(r, 400));
    await withTimeout(page.keyboard.press('Enter'), 5_000, 'Enter');
    console.log('Sent:', text);
} finally {
    browser.disconnect();
}
