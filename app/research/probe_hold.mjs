import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-position=0,0', '--window-size=1200,900'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1200, height: 780 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);
const btn = p.locator('.action-row button').first();
for (let n = 0; n < 22; n++) {
  const lb = (await btn.innerText().catch(() => '')).replace(/\s+/g, '');
  if (lb.includes('完') || lb.includes('交')) {
    await btn.click({ force: true }).catch(() => {});
    await p.waitForTimeout(2500);
    if (await p.locator('#JS_aliyun-captcha-dialog.show').count()) break;
    continue;
  }
  for (let k = 0; k < 12; k++) {
    if (!(await btn.isDisabled().catch(() => true))) break;
    const opts = p.locator('.q-answer.choosable');
    const c = await opts.count();
    if (c) await opts.nth(k % c).click({ force: true }).catch(() => {});
    else { const inp = p.locator('.q-body input'); if (await inp.count()) await inp.first().fill('无').catch(() => {}); }
    await p.waitForTimeout(180);
  }
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(1000);
  if (await p.locator('#JS_aliyun-captcha-dialog.show').count()) break;
}
console.log('dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null);
const trk = await p.locator('#aliyunCaptcha-sliding-body').boundingBox().catch(() => null);
console.log('SLIDER', JSON.stringify(box), JSON.stringify(trk));
console.log('READY');
for (let i = 0; i < 60; i++) {
  await p.waitForTimeout(2000);
  const left = await p.locator('#JS_aliyun-captcha-dialog.show').count();
  if (!left) { console.log('CLOSED at', i * 2, 's'); break; }
}
console.log('score', await p.evaluate(async () => (await (await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' })).text()).slice(0, 110)));
await b.close();