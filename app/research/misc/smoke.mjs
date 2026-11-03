import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 460, height: 700 }, locale: 'zh-CN' });
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(6000);
console.log('title=', await p.title());
console.log('frame count=', p.frames().length);
for (const f of p.frames()) console.log('frame:', f.url().slice(0, 140));
const box = p.locator('.qrcode-box');
console.log('qrcode-box count=', await box.count());
if (await box.count()) { await box.first().screenshot({ path: 'data/shot-qr.png' }); console.log('shot ok'); }
await p.screenshot({ path: 'data/shot-full.png', fullPage: false });
await b.close();
