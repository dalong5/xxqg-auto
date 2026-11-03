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
  if (r.url().includes('detectRisk')) console.log('DETECT', r.status(), (await r.text().catch(() => '')).slice(0, 300));
});
p.on('request', (r) => { if (r.url().includes('detectRisk')) console.log('REQ', r.method(), r.url(), (r.postData() || '').slice(0, 120)); });
await p.goto('https://pc.xuexi.cn/points/exam-practice.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(8000);
console.log('done');
await b.close();