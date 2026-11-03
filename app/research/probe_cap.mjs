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
for (let n = 1; n <= 5; n++) {
  const type = (await p.locator('.q-header').first().innerText()).replace(/\s+/g, '');
  await p.locator('.tips').first().click().catch(() => {});
  await p.waitForTimeout(600);
  const html = await p.locator('.ant-popover .line-feed').first().innerHTML().catch(() => '');
  await p.keyboard.press('Escape').catch(() => {});
  await p.locator('.q-header').first().click({ force: true }).catch(() => {});
  await p.waitForTimeout(250);
  const tips = [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)].map((m) => m[1].trim());
  const opts = p.locator('.q-answer.choosable');
  const c = await opts.count();
  if (type.includes('填空')) {
    const inputs = p.locator('.q-body input');
    const ic = await inputs.count();
    const flat = tips.length === 1 && ic > 1 ? tips[0].split(/[,、；;]/) : tips;
    for (let i = 0; i < ic; i++) await inputs.nth(i).fill(flat[i] || flat[flat.length - 1] || '无').catch(() => {});
  } else if (tips.length) {
    for (const t of tips)
      for (let i = 0; i < c; i++) {
        const s = (await opts.nth(i).innerText()).trim().replace(/^[A-Z][.、]\s*/, '').replace(/\s+/g, '');
        if (s && t.replace(/\s+/g, '').includes(s)) await opts.nth(i).click({ force: true }).catch(() => {});
      }
  }
  await p.waitForTimeout(400);
  const btn = p.locator('.action-row button').first();
  if (await btn.isDisabled().catch(() => true)) console.log('Q' + n, 'disabled');
  await btn.click({ force: true }).catch(() => {});
  for (let k = 0; k < 20; k++) {
    const lb = (await p.locator('.action-row button').first().innerText().catch(() => '')).replace(/\s+/g, '');
    if (lb.includes('完') || (await p.locator('#JS_aliyun-captcha-dialog.show').count())) break;
    await p.waitForTimeout(400);
  }
}
const label = (await p.locator('.action-row button').first().innerText().catch(() => '')).replace(/\s+/g, '');
const dlg = await p.locator('#JS_aliyun-captcha-dialog.show').count();
console.log('label:', label, 'dialog:', dlg, 'url:', p.url());
if (!dlg) { await b.close(); process.exit(0); }
const variants = [
  { name: 'straight-slow', steps: 40, gap: 40, jitter: 0, pause: 400 },
  { name: 'straight-fast', steps: 15, gap: 12, jitter: 0, pause: 120 },
  { name: 'over-right', steps: 30, gap: 25, jitter: 1, pause: 500, extra: 12 },
];
for (const v of variants) {
  const s = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null);
  const t = await p.locator('#aliyunCaptcha-sliding-body').boundingBox().catch(() => null);
  if (!s || !t) { console.log('no slider'); break; }
  const startX = s.x + s.width / 2;
  const startY = s.y + s.height / 2;
  const dist = t.width - s.width + (v.extra || 0);
  await p.mouse.move(startX, startY);
  await p.mouse.down();
  for (let i = 1; i <= v.steps; i++) {
    await p.mouse.move(startX + (dist * i) / v.steps, startY + (v.jitter ? (Math.random() - 0.5) * 2 : 0));
    await p.waitForTimeout(v.gap);
  }
  await p.waitForTimeout(v.pause);
  await p.mouse.up();
  await p.waitForTimeout(2500);
  const left = await p.locator('#JS_aliyun-captcha-dialog.show').count();
  console.log(v.name, 'dialog after:', left, 'failTip:', await p.evaluate(() => document.querySelector('#aliyunCaptcha-sliding-failTip')?.innerText || ''));
  if (!left) break;
  await p.waitForTimeout(1200);
}
const left = await p.locator('#JS_aliyun-captcha-dialog.show').count();
console.log('final dialog:', left);
if (!left) {
  await p.locator('.action-row button').first().click({ force: true }).catch(() => {});
  await p.waitForTimeout(3000);
  console.log('body:', (await p.evaluate(() => document.body.innerText)).slice(0, 250).replace(/\n+/g, ' | '));
}
await b.close();