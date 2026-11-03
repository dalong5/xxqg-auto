import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext()).newPage();
await p.goto('https://pc.xuexi.cn/points/exam-practice.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
await p.evaluate(() => {
  window.__m = [];
  document.addEventListener('mousemove', (e) => window.__m.push({ c: e.clientX, s: e.screenX, p: e.pageX, o: e.offsetX, d: e.detail }), true);
});
await p.mouse.move(400, 400);
await p.mouse.down();
for (let i = 1; i <= 3; i++) { await p.mouse.move(400 + i * 20, 400); await p.waitForTimeout(30); }
await p.mouse.up();
await p.waitForTimeout(300);
console.log('win', await p.evaluate(() => [screenX, screenY, outerWidth, innerWidth]));
console.log(JSON.stringify(await p.evaluate(() => window.__m)));
await b.close();