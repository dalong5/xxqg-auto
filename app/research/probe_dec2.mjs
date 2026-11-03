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
    if (this.__u && /aliyuncs/.test(this.__u)) {
      const rec = { u: this.__u.replace(/https:\/\/[^/]+\//, ''), body: (body || '').toString().slice(0, 9000), resp: '' };
      window.__cap.push(rec);
      this.addEventListener('load', () => { rec.resp = (this.responseText || '').slice(0, 600); });
    }
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
    await p.waitForTimeout(140);
  }
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(700);
}
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(2500);
const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox();
const trk = await p.locator('#aliyunCaptcha-sliding-body').boundingBox();
await p.evaluate(() => { window.__cap.length = 0; });
const sx = box.x + box.width / 2, sy = box.y + box.height / 2, dist = trk.width - box.width;
await p.mouse.move(sx, sy); await p.mouse.down();
for (let i = 1; i <= 30; i++) { await p.mouse.move(sx + (dist * i) / 30, sy); await p.waitForTimeout(16); }
await p.mouse.up();
await p.waitForTimeout(3000);
const caps = await p.evaluate(() => window.__cap);
for (const c of caps) {
  if (!c.body.includes('VerifyCaptchaV3')) continue;
  const q = new URLSearchParams(c.body);
  const p2 = JSON.parse(q.get('CaptchaVerifyParam'));
  const buf = Buffer.from(p2.data, 'base64');
  console.log('dataBytes', buf.length, 'head', buf.slice(0, 40).toString('hex'));
  const txt = buf.toString('utf8').replace(/[^\x20-\x7e]/g, '.');
  console.log('asText', txt.slice(0, 300));
  console.log('resp', c.resp);
}
await b.close();