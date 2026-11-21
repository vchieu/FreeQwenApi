import puppeteer from 'puppeteer';

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
const page = (await browser.pages()).find(p => p.url().includes('chat.qwen.ai'));
if (!page) throw new Error('No Qwen tab');

const result = await page.evaluate(async () => {
    const src = 'https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.49/js/main.js';
    const text = await (await fetch(src)).text();
    const needles = ['choices[0].delta', '.delta.content', 'delta?.content', 'delta.content', 'response.created', '"data: "', 'data: '];
    const hits = [];
    for (const needle of needles) {
        let from = 0;
        for (let n = 0; n < 4; n++) {
            const i = text.indexOf(needle, from);
            if (i < 0) break;
            hits.push({ needle, at: i, around: text.slice(Math.max(0, i - 450), i + 650) });
            from = i + needle.length;
        }
    }
    return { size: text.length, hits };
});

console.log('SIZE', result.size);
for (const h of result.hits) {
    console.log(`\n=== ${h.needle} @${h.at} ===\n${h.around}`);
}
browser.disconnect();
