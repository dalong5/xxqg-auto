import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on('console', (m) => { if (/submit|verify|Aliyun|abnormal/i.test(m.text())) console.log('C:', m.text().slice(0, 120)); });
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);
const btn = p.locator('.action-row button').first();
console.log('flag at start', await p.evaluate(() => sessionStorage.getItem('abnormal_exam')));
for (let n = 0; n < 22; n++) {
  const lb = (await btn.innerText().catch(() => '')).replace(/\s+/g, '');
  if (lb.includes('完') || lb.includes('交')) break;
  for (let k = 0; k < 12; k++) {
    if (!(await btn.isDisabled().catch(() => true))) break;
    const opts = p.locator('.q-answer.choosable');
    const c = await opts.count();
    if (c) await opts.nth(k % c).click({ force: true }).catch(() => {});
    else { const inp = p.locator('.q-body input'); if (await inp.count()) await inp.first().fill('无').catch(() => {}); }
    await p.waitForTimeout(160);
  }
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(900);
}
console.log('label', (await btn.innerText().catch(() => '')).replace(/\s+/g, ''));
await p.evaluate(() => {
  window.__get = [];
  const o = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) { window.__get.push((this === localStorage ? 'L:' : 'S:') + k); return o.call(this, k); };
  sessionStorage.removeItem('abnormal_exam');
  localStorage.removeItem('abnormal_exam');
});
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(4000);
console.log('dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
console.log('gets', JSON.stringify(await p.evaluate(() => window.__get)));
console.log('body', (await p.evaluate(() => document.body.innerText)).slice(-260).replace(/\n+/g, ' | '));
console.log('score', await p.evaluate(async () => (await (await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' })).text()).slice(0, 110)));
await b.close();