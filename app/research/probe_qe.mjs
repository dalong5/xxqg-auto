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
  const tips = [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)].map(m => m[1].trim());
  const opts = p.locator('.q-answer.choosable');
  const c = await opts.count();
  if (type.includes('点选')) {
    const blanks = p.locator('.click-box');
    const total = await blanks.count();
    const chips = p.locator('.fill-answer');
    const texts = (await chips.allInnerTexts()).map(s => s.trim());
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
  } else if (tips.length) {
    for (const t of tips) for (let i = 0; i < c; i++) {
      const s = (await opts.nth(i).innerText()).trim().replace(/^[A-Z][.、]\s*/, '').replace(/\s+/g, '');
      if (s && t.replace(/\s+/g, '').includes(s)) await opts.nth(i).click({ force: true }).catch(() => {});
    }
  }
  await p.waitForTimeout(500);
  await p.locator('.action-row button').first().click().catch(e => console.log('clickerr', e.message.slice(0, 50)));
  let label = '';
  for (let s = 0; s < 10; s++) {
    await p.waitForTimeout(1000);
    label = (await p.locator('.action-row button').first().innerText().catch(() => '')).replace(/\s+/g, '');
    if (s === 0 || label.includes('完')) console.log('  t' + s + ' label=', label, 'analysis=', await p.locator('text=正确答案').count());
    if (label.includes('完')) break;
  }
  console.log('Q' + n, type, 'label after:', label);
  const capDlg = await p.locator('#JS_aliyun-captcha-dialog').count();
  console.log('CAPTCHA present:', capDlg, 'show:', await p.locator('#JS_aliyun-captcha-dialog.show').count());
  if (capDlg) console.log('CAP HTML:', (await p.evaluate(() => document.querySelector('#JS_aliyun-captcha-dialog')?.outerHTML || '')).slice(-2200));
  if (label.includes('完')) {
    const s = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox().catch(() => null);
    const t = await p.locator('#aliyunCaptcha-sliding-body').boundingBox().catch(() => null);
    console.log('slider', JSON.stringify(s), 'track', JSON.stringify(t));
    if (s && t) {
      const startX = s.x + s.width / 2, startY = s.y + s.height / 2;
      const dist = t.width - s.width - 2;
      await p.mouse.move(startX, startY);
      await p.mouse.down();
      for (let i = 1; i <= 28; i++) {
        const e = 1 - Math.pow(1 - i / 28, 3);
        await p.mouse.move(startX + dist * e, startY + (Math.random() - 0.5) * 3);
        await p.waitForTimeout(15);
      }
      await p.mouse.up();
      await p.waitForTimeout(2500);
      console.log('dialog after drag:', await p.locator('#JS_aliyun-captcha-dialog.show').count(), 'errText:', await p.evaluate(() => document.querySelector('#aliyunCaptcha-sliding-failTip')?.innerText || ''));
      await p.waitForTimeout(1500);
      console.log('label now:', (await p.locator('.action-row button').first().innerText().catch(() => '')).replace(/\s+/g, ''));
    }
    break;
  }
    await p.evaluate(() => document.querySelector('.action-row button').click());
    await p.waitForTimeout(3000);
    console.log('AFTER FINISH:', (await p.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\n+/g, ' | '));
    console.log('modal:', await p.locator('.ant-modal').count());
    if (await p.locator('.ant-modal').count()) {
      console.log('modal html:', (await p.locator('.ant-modal').first().innerHTML()).slice(0, 500));
      await p.locator('.ant-modal button').last().click().catch(() => {});
      await p.waitForTimeout(2500);
      console.log('AFTER CONFIRM:', (await p.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n+/g, ' | '));
    }
    break;
  }
}
await p.waitForTimeout(4000);
console.log('FINAL URL', p.url());
await b.close();
