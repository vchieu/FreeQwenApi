import puppeteer from 'puppeteer';

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
for (const page of await browser.pages()) {
    if (!page.url().includes('chat.qwen.ai')) continue;
    const info = await page.evaluate(() => ({
        url: location.href,
        captcha: /captcha|verification|slide|验证|请完成|安全验证/i.test(document.body.innerText),
        inputs: [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
            .map(el => ({
                tag: el.tagName,
                placeholder: el.getAttribute('placeholder') || '',
                editable: el.getAttribute('contenteditable'),
                cls: (el.className || '').toString().slice(0, 80)
            }))
    }));
    console.log(JSON.stringify(info));
}
browser.disconnect();
