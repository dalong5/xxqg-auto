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
for (let n = 1; n <= 6; n++) {
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
      await p.waitForTimeout(200);
      let pick = -1, best = 0;
      texts.forEach((t, idx) => { if (t && rest.startsWith(t) && t.length > best) { pick = idx; best = t.length; } });
      if (pick >= 0) { await chips.nth(pick).click({ force: true }).catch(() => {}); rest = rest.slice(texts[pick].length); }
      await p.waitForTimeout(250);
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
  const next = p.locator('.action-row > button').first();
  if (await next.isDisabled().catch(() => true)) { console.log('Q' + n, type, 'DISABLED'); break; }
  if (n === 5) {
    const info = await p.evaluate(() => {
      const btn = document.querySelector('.action-row button');
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height, vh: innerHeight },
        top: top ? top.tagName + '.' + top.className + ' :: ' + (top.innerText || '').slice(0, 30) : 'none',
        disabled: btn.disabled,
      };
    });
    console.log('INFO', JSON.stringify(info));
    await p.evaluate(() => document.querySelector('.action-row button').click());
    await p.waitForTimeout(2500);
    console.log('after DOM click:', (await p.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n+/g, ' | '));
    break;
  }
  await p.evaluate(() => document.querySelector('.action-row button').click());
  await p.waitForTimeout(2000);
  console.log('Q' + n, type, 'ok');
}
await b.close();
