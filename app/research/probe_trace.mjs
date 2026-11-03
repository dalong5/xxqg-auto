import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  window.__capLog = [];
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__u && /captcha-open|aliyuncs/.test(this.__u)) if (!window.__capBody) window.__capBody = (body || '').toString().slice(0, 900);
    return origSend.apply(this, arguments);
  };
  const of = window.fetch;
  window.fetch = function (u, o) {
    if (typeof u === 'string' && /captcha-open|aliyuncs/.test(u)) window.__capLog.push({ u: u.slice(0, 60), len: (o && o.body ? o.body.toString().length : 0) });
    return of.apply(this, arguments);
  };
});
await ctx.addCookies(cookies);
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);
const btn = p.locator('.action-row button').first();
for (let n = 1; n <= 12; n++) {
  for (let k = 0; k < 12; k++) {
    if (!(await btn.isDisabled().catch(() => true))) break;
    const opts = p.locator('.q-answer.choosable');
    const c = await opts.count();
    if (c) await opts.nth(k % c).click({ force: true }).catch(() => {});
    else { const inp = p.locator('.q-body input'); if (await inp.count()) await inp.first().fill('无').catch(() => {}); }
    await p.waitForTimeout(200);
  }
  if ((await btn.innerText().catch(() => '')).includes('完')) break;
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(1000);
}
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(3500);
const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null);
const trk = await p.locator('#aliyunCaptcha-sliding-body').boundingBox().catch(() => null);
if (box && trk) {
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2, dist = trk.width - box.width;
  await p.mouse.move(sx, sy); await p.waitForTimeout(250); await p.mouse.down(); await p.waitForTimeout(200);
  for (let i = 1; i <= 40; i++) { await p.mouse.move(sx + dist * i / 40, sy + (Math.random() - 0.5) * 2); await p.waitForTimeout(20 + Math.random() * 30); }
  await p.waitForTimeout(300); await p.mouse.up(); await p.waitForTimeout(3000);
}
console.log('capbody', await p.evaluate(() => window.__capBody || 'none'));
await b.close();