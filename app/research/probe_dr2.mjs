import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN' });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on('response', async (r) => {
  if (r.url().includes('/api/exam/')) console.log('RES', r.url().split('/api/exam/')[1].slice(0, 50), r.status(), (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' '));
});
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(6000);
await b.close();