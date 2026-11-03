import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 120)); });
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
    await p.waitForTimeout(220);
  }
  if ((await btn.innerText().catch(() => '')).includes('完')) break;
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(1200);
}
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(3500);
console.log('dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());

async function drag(profile) {
  errs.length = 0;
  console.log('clientX before', await p.evaluate(() => window.AliyunCaptcha_clientX), 'keys', await p.evaluate(() => Object.keys(window.AliyunCaptcha || {}).join(',')));
  const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null);
  const trk = await p.locator('#aliyunCaptcha-sliding-body').boundingBox().catch(() => null);
  if (!box || !trk) return 'no-slider';
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  const dist = trk.width - box.width + (profile.extra || 0);
  await p.mouse.move(sx, sy);
  await p.waitForTimeout(profile.hold || 150);
  await p.mouse.down();
  await p.waitForTimeout(profile.press || 150);
  for (let i = 1; i <= profile.steps; i++) {
    const t = i / profile.steps;
    const ease = profile.linear ? t : 1 - Math.pow(1 - t, 3);
    await p.mouse.move(sx + dist * ease, sy + (Math.random() - 0.5) * (profile.jitter || 0));
    await p.waitForTimeout(profile.gapMin + Math.random() * (profile.gapMax - profile.gapMin));
  }
  await p.waitForTimeout(profile.pause || 200);
  await p.mouse.up();
  await p.waitForTimeout(2500);
  console.log('clientX after', await p.evaluate(() => window.AliyunCaptcha_clientX));
  return 'dialog=' + (await p.locator('#JS_aliyun-captcha-dialog.show').count()) + ' errs=' + JSON.stringify(errs);
}

const profiles = [
  { name: 'd320', steps: 40, gapMin: 18, gapMax: 40, jitter: 2, pause: 300, press: 200, extra: -20 },
  { name: 'd340', steps: 40, gapMin: 18, gapMax: 40, jitter: 2, pause: 300, press: 200, extra: 0 },
  { name: 'd358', steps: 40, gapMin: 18, gapMax: 40, jitter: 2, pause: 300, press: 200, extra: 18 },
  { name: 'd370', steps: 40, gapMin: 18, gapMax: 40, jitter: 2, pause: 300, press: 200, extra: 30 },
];
for (const pr of profiles) {
  const r = await drag(pr);
  console.log(pr.name, r);
  if (r.startsWith('dialog=0')) break;
  await p.waitForTimeout(1500);
}
console.log('final dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
console.log('score', await p.evaluate(async () => (await (await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' })).text()).slice(0, 110)));
await b.close();