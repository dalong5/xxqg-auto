import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  window.__cap = [];
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__u && this.__u.includes('aliyuncs') && String(body).includes('VerifyCaptchaV3')) window.__cap.push(String(body));
    return os.apply(this, arguments);
  };
});
await ctx.addCookies(cookies);
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3000);
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
    await p.waitForTimeout(130);
  }
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(650);
}
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(2500);
await p.waitForSelector('#aliyunCaptcha-sliding-slider', { timeout: 15000 }).catch(() => console.log('no slider'));
const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox();
const trk = await p.locator('#aliyunCaptcha-sliding-body').boundingBox();
const sx = box.x + box.width / 2, sy = box.y + box.height / 2, dist = trk.width - box.width;
const run = async (steps) => {
  await p.evaluate(() => { window.__cap.length = 0; });
  await p.mouse.move(sx, sy); await p.mouse.down();
  if (steps === 0) { /* click only */ } else for (let i = 1; i <= steps; i++) { await p.mouse.move(sx + (dist * i) / steps, sy); await p.waitForTimeout(16); }
  await p.mouse.up();
  await p.waitForTimeout(2500);
  const cap = (await p.evaluate(() => window.__cap))[0] || '';
  if (!cap) return console.log('steps', steps, 'no capture');
  const data = JSON.parse(new URLSearchParams(cap).get('CaptchaVerifyParam')).data;
  const buf = Buffer.from(data, 'base64');
  console.log('steps', steps, 'len', buf.length, 'sha', crypto.createHash('md5').update(buf).digest('hex').slice(0, 12));
  const dlg = await p.locator('#JS_aliyun-captcha-dialog.show').count();
  if (dlg) await p.locator('#JS_aliyun-captcha-slider' + '').count();
};
await run(0);
await p.waitForTimeout(1500);
await run(5);
await p.waitForTimeout(1500);
await run(60);
await b.close();