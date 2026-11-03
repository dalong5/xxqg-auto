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
const btn = p.locator('.action-row button').first();
for (let n = 1; n <= 12; n++) {
  for (let k = 0; k < 12; k++) {
    if (!(await btn.isDisabled().catch(() => true))) break;
    const opts = p.locator('.q-answer.choosable');
    const c = await opts.count();
    if (c) await opts.nth(k % c).click({ force: true }).catch(() => {});
    else { const inp = p.locator('.q-body input'); if (await inp.count()) await inp.first().fill('无').catch(() => {}); }
    await p.waitForTimeout(180);
  }
  if ((await btn.innerText().catch(() => '')).includes('完')) break;
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(900);
}
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(3500);
const snap = () => p.evaluate(() => {
  const s = document.querySelector('#aliyunCaptcha-sliding-slider');
  const l = document.querySelector('#aliyunCaptcha-sliding-left');
  return { left: s?.style.left, transform: s && getComputedStyle(s).transform, rect: s && s.getBoundingClientRect().x, lw: l?.style.width };
});
const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox();
const trk = await p.locator('#aliyunCaptcha-sliding-body').boundingBox();
const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
const dist = trk.width - box.width;
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && /滑块|verify/.test(m.text())) errs.push(m.text().slice(0, 90)); });
const runs = [
  { n: 'quick-nopause', steps: 20, gap: 10, pause: 0 },
  { n: 'mid', steps: 30, gap: 12, pause: 40 },
  { n: 'steps-api', steps: 0, gap: 0, pause: 0 },
];
for (const r of runs) {
  errs.length = 0;
  const dlgNow = await p.locator('#JS_aliyun-captcha-dialog.show').count();
  if (!dlgNow) { console.log(r.n, 'dialog gone'); break; }
  await p.mouse.move(sx, sy);
  await p.mouse.down();
  if (r.steps === 0) {
    await p.mouse.move(sx + dist, sy, { steps: 35 });
  } else {
    for (let i = 1; i <= r.steps; i++) { await p.mouse.move(sx + (dist * i) / r.steps, sy); if (r.gap) await p.waitForTimeout(r.gap); }
  }
  if (r.pause) await p.waitForTimeout(r.pause);
  await p.mouse.up();
  await p.waitForTimeout(2500);
  console.log(r.n, 'dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count(), 'errs', JSON.stringify(errs));
  if (!(await p.locator('#JS_aliyun-captcha-dialog.show').count())) break;
  await p.waitForTimeout(800);
}
await b.close();