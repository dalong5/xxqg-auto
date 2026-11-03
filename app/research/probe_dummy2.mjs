import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on('console', (m) => { if (/STUB|Aliyun/.test(m.text())) console.log('C:', m.text().slice(0, 60)); });
p.on('request', (r) => { if (r.url().includes('/api/exam/')) console.log('REQ', r.method(), r.url().slice(-40), (r.postData() || '').slice(0, 400)); });
p.on('response', async (r) => {
  if (r.url().includes('/api/exam/')) console.log('RES', r.status(), (await r.text().catch(() => '')).slice(0, 300));
});
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);
const btn = p.locator('.action-row button').first();
for (let n = 0; n < 22; n++) {
  const lb = (await btn.innerText().catch(() => '')).replace(/\s+/g, '');
  if (lb.includes('完') || lb.includes('交')) break;
  for (let k = 0; k < 12; k++) {
    if (!(await btn.isDisabled().catch(() => true))) break;
    const opts = p.locator('.q-answer.choosable');
    const c = await opts.count();
    if (c) await opts.nth(k % c).click({ force: true }).catch(() => {});
    else { const inp = p.locator('.q-body input'); if (await inp.count()) await inp.first().fill('无').catch(() => {}); }
    await p.waitForTimeout(150);
  }
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(800);
}
console.log('label', (await btn.innerText().catch(() => '')).replace(/\s+/g, ''));
await p.evaluate(() => {
  const stub = (o) => { console.log('STUB called'); setTimeout(() => { console.log('STUB success'); o.success('dummy-param'); }, 200); };
  stub.__stub = true;
  window.initAliyunCaptcha = stub;
});
console.log('stub installed', await p.evaluate(() => !!(window.initAliyunCaptcha && window.initAliyunCaptcha.__stub)));
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(5000);
console.log('dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
console.log('body', (await p.evaluate(() => document.body.innerText)).slice(-200).replace(/\n+/g, ' | '));
await b.close();