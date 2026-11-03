import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, hasTouch: true });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);

async function answer(n) {
  const type = (await p.locator('.q-header').first().innerText()).replace(/\s+/g, '');
  await p.locator('.tips').first().click().catch(() => {});
  await p.waitForTimeout(700);
  const html = await p.locator('.ant-popover .line-feed').first().innerHTML().catch(() => '');
  await p.keyboard.press('Escape').catch(() => {});
  await p.locator('.q-header').first().click({ force: true }).catch(() => {});
  await p.waitForTimeout(200);
  const tips = [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)].map((m) => m[1].trim());
  const opts = p.locator('.q-answer.choosable');
  const c = await opts.count();
  if (type.includes('点选')) {
    const blanks = p.locator('.click-box');
    const total = await blanks.count();
    const chips = p.locator('.fill-answer');
    const texts = (await chips.allInnerTexts()).map((s) => s.trim());
    let rest = tips.join('');
    for (let i = 0; i < total; i++) {
      await blanks.nth(i).click({ force: true }).catch(() => {});
      await p.waitForTimeout(180);
      let pick = -1, best = 0;
      texts.forEach((t, idx) => { if (t && rest.startsWith(t) && t.length > best) { pick = idx; best = t.length; } });
      if (pick >= 0) { await chips.nth(pick).click({ force: true }).catch(() => {}); rest = rest.slice(texts[pick].length); }
    }
  } else if (type.includes('填空')) {
    const inputs = p.locator('.q-body input');
    const ic = await inputs.count();
    const flat = tips.length === 1 && ic > 1 ? tips[0].split(/[,、；;]/) : tips;
    for (let i = 0; i < ic; i++) await inputs.nth(i).fill(flat[i] || flat[flat.length - 1] || '无').catch(() => {});
  } else if (tips.length && c) {
    for (const t of tips) for (let i = 0; i < c; i++) {
      const s = (await opts.nth(i).innerText()).trim().replace(/^[A-Z][.、]\s*/, '').replace(/\s+/g, '');
      if (s && t.replace(/\s+/g, '').includes(s)) await opts.nth(i).click({ force: true }).catch(() => {});
    }
  }
  console.log('Q' + n, type, 'disabled=', await p.locator('.action-row button').first().isDisabled().catch(() => 'na'));
  await p.waitForTimeout(400);
  await p.locator('.action-row button').first().click({ force: true }).catch(() => {});
  for (let k = 0; k < 25; k++) {
    if (await p.locator('#JS_aliyun-captcha-dialog.show').count()) return true;
    if ((await p.locator('.action-row button').first().innerText().catch(() => '')).includes('完')) return true;
    await p.waitForTimeout(400);
  }
  return false;
}

for (let n = 1; n <= 5; n++) {
  const capped = await answer(n);
  console.log('  captcha?', capped);
  if (capped) break;
}

console.log('dialog:', await p.locator('#JS_aliyun-captcha-dialog.show').count());
const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null);
const trk = await p.locator('#aliyunCaptcha-sliding-body').boundingBox().catch(() => null);
console.log('slider', JSON.stringify(box), 'track', JSON.stringify(trk));
if (!box || !trk) { await b.close(); process.exit(0); }
const sx = box.x + box.width / 2, sy = box.y + box.height / 2, dist = trk.width - box.width;

// 1) 在轨道中心按下
await p.mouse.move(trk.x + trk.width / 2, sy);
await p.mouse.down();
await p.mouse.move(trk.x + trk.width / 2 + dist, sy, { steps: 25 });
await p.mouse.up();
await p.waitForTimeout(2500);
console.log('A body-drag dialog:', await p.locator('#JS_aliyun-captcha-dialog.show').count(), 'sliderX:', (await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null))?.x);

// 2) 触摸事件
if (await p.locator('#JS_aliyun-captcha-dialog.show').count()) {
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: sy, id: 1 }] });
  await touch('touchStart', sx);
  for (let i = 1; i <= 25; i++) { await touch('touchMove', sx + (dist * i) / 25); await p.waitForTimeout(20); }
  await touch('touchEnd', sx + dist);
  await p.waitForTimeout(2500);
  console.log('B touch dialog:', await p.locator('#JS_aliyun-captcha-dialog.show').count());
}

// 3) 关掉验证码再点完成
if (await p.locator('#JS_aliyun-captcha-dialog.show').count()) {
  await p.locator('#JS_aliyun-captcha-close-btn').click().catch(() => {});
  await p.waitForTimeout(600);
  await p.locator('.action-row button').first().click({ force: true }).catch(() => {});
  await p.waitForTimeout(3000);
  console.log('C close+click dialog:', await p.locator('#JS_aliyun-captcha-dialog.show').count());
  console.log('C body:', (await p.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n+/g, ' | '));
}
await b.close();