import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);
const dump = async () => p.evaluate(() => {
  const btns = [...document.querySelectorAll('.action-row button')];
  const opts = [...document.querySelectorAll('.q-answer')];
  return {
    actionRows: document.querySelectorAll('.action-row').length,
    btns: btns.map(b => ({ t: b.innerText, dis: b.disabled, cls: b.className })),
    opts: opts.map(o => ({ cls: o.className, txt: o.innerText.trim().slice(0, 12) })),
  };
});
console.log('BEFORE', JSON.stringify(await dump()));
await p.locator('.q-answer.choosable').first().click();
await p.waitForTimeout(900);
console.log('AFTER1', JSON.stringify(await dump()));
await p.locator('.q-answer.choosable').nth(1).click().catch(() => {});
await p.waitForTimeout(900);
console.log('AFTER2', JSON.stringify(await dump()));
await b.close();
