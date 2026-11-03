import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on('response', (r) => {
  const u = r.url();
  if (/captcha|alicdn|aliyun|AWSC/i.test(u)) console.log('NET', r.status(), u.slice(0, 160));
});
p.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') console.log('CERR', m.text().slice(0, 200)); });
p.on('requestfailed', (r) => {
  const u = r.url();
  if (/captcha|alicdn|aliyun|AWSC/i.test(u)) console.log('NETFAIL', u.slice(0, 160), r.failure()?.errorText);
});
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
    else {
      const chips = p.locator('.fill-answer');
      const cn = await chips.count();
      if (cn) { await p.locator('.click-box').first().click({ force: true }).catch(() => {}); await chips.nth(k % cn).click({ force: true }).catch(() => {}); }
      else { const inp = p.locator('.q-body input'); if (await inp.count()) await inp.first().fill('无').catch(() => {}); }
    }
    await p.waitForTimeout(250);
  }
  const lb = (await btn.innerText().catch(() => '')).replace(/\s+/g, '');
  if (lb.includes('完')) break;
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(1500);
}
console.log('label', (await btn.innerText().catch(() => '')).replace(/\s+/g, ''));
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(4000);
console.log('dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
console.log('globals', await p.evaluate(() => Object.keys(window).filter((k) => /aptcha/i.test(k)).join(',')));
for (const f of p.frames()) {
  const has = await f.locator('#aliyunCaptcha-sliding-slider').count().catch(() => 0);
  const hasBar = await f.locator('.aliyunCaptcha-sliding-slider, #nc_1_n1z, .nc_iconfont').count().catch(() => 0);
  console.log('FRAME', JSON.stringify(f.url()).slice(0, 90), 'slider', has, 'other', hasBar);
  if (has) {
    const box = await f.locator('#aliyunCaptcha-sliding-slider').boundingBox();
    const trk = await f.locator('#aliyunCaptcha-sliding-body').boundingBox();
    console.log('  box', JSON.stringify(box), 'trk', JSON.stringify(trk));
    if (box && trk) {
      const sx = box.x + box.width / 2, sy = box.y + box.height / 2, dist = trk.width - box.width;
      await p.mouse.move(sx, sy); await p.mouse.down();
      for (let i = 1; i <= 28; i++) { await p.mouse.move(sx + dist * i / 28, sy); await p.waitForTimeout(25); }
      await p.mouse.up(); await p.waitForTimeout(2500);
      console.log('  after drag dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
      await f.locator('.action-row button').count();
      console.log('  score', await p.evaluate(async () => (await (await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' })).text()).slice(0, 110)));
    }
  }
}
await b.close();