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
  console.log('Q' + n, type);
  await p.locator('.tips').first().click().catch(() => {});
  await p.waitForTimeout(700);
  const html = await p.locator('.ant-popover .line-feed').first().innerHTML().catch(() => '');
  await p.keyboard.press('Escape').catch(() => {});
  await p.locator('.q-header').first().click({ force: true }).catch(() => {});
  await p.waitForTimeout(200);
  const tips = [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)].map((m) => m[1].trim());
  console.log('  tips', JSON.stringify(tips));
  const opts = p.locator('.q-answer.choosable');
  const c = await opts.count();
  console.log('  opts', c);
  if (type.includes('点选')) {
    const blanks = p.locator('.click-box');
    const total = await blanks.count();
    const chips = p.locator('.fill-answer');
    const texts = (await chips.allInnerTexts()).map((s) => s.trim());
    let rest = tips.join('');
    console.log('  blanks', total, 'chips', texts.length);
    for (let i = 0; i < total; i++) {
      await blanks.nth(i).click({ force: true }).catch(() => {});
      await p.waitForTimeout(200);
      let pick = -1, best = 0;
      texts.forEach((t, idx) => { if (t && rest.startsWith(t) && t.length > best) { pick = idx; best = t.length; } });
      if (pick >= 0) { await chips.nth(pick).click({ force: true }).catch(() => {}); rest = rest.slice(texts[pick].length); }
    }
  } else if (type.includes('填空')) {
    const inputs = p.locator('.q-body input');
    const ic = await inputs.count();
    console.log('  inputs', ic);
    const flat = tips.length === 1 && ic > 1 ? tips[0].split(/[,、；;]/) : tips;
    for (let i = 0; i < ic; i++) await inputs.nth(i).fill(flat[i] || flat[flat.length - 1] || '无').catch(() => {});
  } else if (tips.length && c) {
    for (const t of tips)
      for (let i = 0; i < c; i++) {
        const s = (await opts.nth(i).innerText()).trim().replace(/^[A-Z][.、]\s*/, '').replace(/\s+/g, '');
        if (s && t.replace(/\s+/g, '').includes(s)) { await opts.nth(i).click({ force: true }).catch(() => {}); console.log('   picked', i); }
      }
  }
  await p.waitForTimeout(400);
  const btn = p.locator('.action-row button').first();
  console.log('  disabled', await btn.isDisabled().catch(() => 'na'));
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(2500);
  const dlg = await p.locator('#JS_aliyun-captcha-dialog.show').count();
  console.log('  dialog', dlg);
  if (dlg) {
    const s = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null);
    const t = await p.locator('#aliyunCaptcha-sliding-body').boundingBox().catch(() => null);
    console.log('  slider', JSON.stringify(s), 'track', JSON.stringify(t));
    if (s && t) {
      const sx = s.x + s.width / 2, sy = s.y + s.height / 2, dist = t.width - s.width;
      console.log('  onTop', await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '#' + e.id + '.' + e.className : 'none'; }, [sx, sy]));
      await p.evaluate(([sx, sy, dist]) => {
        const el = document.querySelector('#aliyunCaptcha-sliding-slider');
        const mk = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        mk('pointerdown', sx, sy);
        for (let i = 1; i <= 30; i++) {
          setTimeout(() => {
            mk('pointermove', sx + (dist * i) / 30, sy);
            if (i === 30) setTimeout(() => mk('pointerup', sx + dist, sy), 400);
          }, i * 25);
        }
      }, [sx, sy, dist]);
      await p.waitForTimeout(4000);
      const s2 = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null);
      console.log('  slider after', JSON.stringify(s2));
      console.log('  left w', await p.evaluate(() => document.querySelector('#aliyunCaptcha-sliding-left')?.style.width));
      console.log('  after drag dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
      console.log('  errCode', await p.evaluate(() => document.querySelector('#aliyunCaptcha-sliding-errorCode')?.innerText || ''));
      console.log('  dialogHTML', (await p.evaluate(() => document.querySelector('#JS_aliyun-captcha-dialog')?.outerHTML || '')).slice(-1200));
    }
    break;
  }
}
await b.close();