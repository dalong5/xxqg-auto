import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
p.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url().slice(0, 160)); });
await p.goto('https://pc.xuexi.cn/points/exam-practice.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);
console.log('aliyunCaptcha', await p.evaluate(() => typeof window.aliyunCaptcha), 'AWSC', await p.evaluate(() => typeof window.AWSC), 'nc', await p.evaluate(() => typeof window.nc));
await b.close();