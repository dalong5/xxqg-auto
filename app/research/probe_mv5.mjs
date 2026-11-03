import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && /滑块|verify|Aliyun/.test(m.text())) errs.push(m.text().slice(0, 90)); });
await p.goto('https://pc.xueji.cn/points/my-points.html'.replace('xueji', 'xuexi'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);

const hasDlg = () => p.locator('#JS_aliyun-captcha-dialog.show').count();
const btn = p.locator('.action-row button').first();
let got = false;
for (let n = 0; n < 20 && !got; n++) {
  const lb = (await btn.innerText().catch(() => '')).replace(/\s+/g, '');
  if (lb.includes('完') || lb.includes('交')) {
    await btn.click({ force: true }).catch(() => {});
    await p.waitForTimeout(2500);
    if (await hasDlg()) { got = true; break; }
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
  await p.waitForTimeout(1200);
  if (await hasDlg()) got = true;
}
console.log('got captcha', got, 'dialog', await hasDlg());
if (!got) { await b.close(); process.exit(0); }

const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox();
const trk = await p.locator('#aliyunCaptcha-sliding-body').boundingBox();
const sx = box.x + box.width / 2, sy = box.y + box.height / 2, dist = trk.width - box.width;
const runs = [
  { n: 'left-edge', steps: 35, gap: 20, off: 4, extra: 0 },
  { n: 'left-overshoot', steps: 35, gap: 20, off: 4, extra: 40 },
  { n: 'mid-overshoot', steps: 35, gap: 20, off: 20, extra: 40 },
];
for (const r of runs) {
  errs.length = 0;
  if (!(await hasDlg())) { console.log(r.n, 'dialog gone'); break; }
  const stx = box.x + r.off;
  await p.mouse.move(stx, sy);
  await p.mouse.down();
  if (r.steps === 0) await p.mouse.move(stx + dist + r.extra, sy, { steps: 35 });
  else for (let i = 1; i <= r.steps; i++) { await p.mouse.move(stx + ((dist + r.extra) * i) / r.steps, sy); if (r.gap) await p.waitForTimeout(r.gap); }
  if (r.pause) await p.waitForTimeout(r.pause);
  await p.mouse.up();
  await p.waitForTimeout(2500);
  console.log(r.n, 'dialog', await hasDlg(), 'errs', JSON.stringify(errs));
  if (!(await hasDlg())) break;
  await p.waitForTimeout(800);
}
console.log('score', await p.evaluate(async () => (await (await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' })).text()).slice(0, 110)));
await b.close();