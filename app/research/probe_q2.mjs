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
await p.waitForTimeout(3500);
const card = p.locator('.my-points-card', { hasText: '每日答题' }).first();
console.log('cards:', await p.locator('.my-points-card').count(), 'match:', await card.count());
await card.locator('text=去答题').first().click();
await p.waitForTimeout(6000);
console.log('pages:', ctx.pages().length);
for (const pg of ctx.pages()) console.log(' page url:', pg.url());
const ex = ctx.pages().at(-1);
const body = await ex.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 700));
console.log('--- exam body ---\n' + body);
const counts = await ex.evaluate(() => ({
  qbody: document.querySelectorAll('.q-body').length,
  qheader: document.querySelectorAll('.q-header').length,
  qanswer: document.querySelectorAll('.q-answer').length,
  choosable: document.querySelectorAll('.q-answer.choosable').length,
  actionRow: document.querySelectorAll('.action-row').length,
  actionBtns: document.querySelectorAll('.action-row > button').length,
  tip: [...document.querySelectorAll('*')].filter(e => e.textContent?.trim() === '查看提示').length,
  buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).slice(0, 10),
}));
console.log(JSON.stringify(counts));
await b.close();
