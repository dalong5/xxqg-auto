import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext();
await ctx.addInitScript(() => {
  window.__ck = [];
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(document, 'cookie', {
    get() { return desc.get.call(document); },
    set(v) { if (String(v).includes('abnormal') || String(v).length > 40) window.__ck.push(String(v).slice(0, 80) + ' || ' + new Error().stack.split('\n').slice(1, 5).join(' <- ').slice(0, 400)); return desc.set.call(document, v); },
  });
});
await ctx.addCookies(cookies);
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.evaluate(() => { window.__ck.length = 0; });
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(5000);
const ck = await p.evaluate(() => window.__ck);
for (const c of ck) console.log('CK', c);
await b.close();