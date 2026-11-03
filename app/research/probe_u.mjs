import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext()).newPage();
await p.goto('https://pc.xuexi.cn/points/exam-practice.html', { waitUntil: 'domcontentloaded' });
const urls = await p.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean));
console.log(urls.join('\n'));
await b.close();