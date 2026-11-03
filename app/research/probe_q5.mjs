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
await p.waitForTimeout(2500);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);
for (let n = 1; n <= 12; n++) {
  const body = p.locator('.q-body').first();
  if (!(await body.count())) { console.log('end'); break; }
  const type = (await p.locator('.q-header').first().innerText()).replace(/\s+/g, '');
  if (type.includes('点选')) {
    console.log('FOUND', type);
    console.log(await body.innerHTML());
    break;
  }
  await p.locator('.tips').first().click().catch(() => {});
  await p.waitForTimeout(600);
  const html = await p.locator('.ant-popover .line-feed').first().innerHTML().catch(() => '');
  await p.mouse.click(20, 20).catch(() => {});
  const tips = [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)].map(m => m[1].trim());
  const opts = p.locator('.q-answer.choosable');
  const c = await opts.count();
  if (type.includes('填空')) {
    const inputs = p.locator('.q-body input');
    const ic = await inputs.count();
    for (let i = 0; i < ic; i++) if (tips[i]) await inputs.nth(i).fill(tips[i]).catch(() => {});
  } else if (tips.length) {
    for (const t of tips) for (let i = 0; i < c; i++) {
      const s = (await opts.nth(i).innerText()).trim().replace(/^[A-Z][.、]\s*/, '').replace(/\s+/g, '');
      if (s && t.replace(/\s+/g, '').includes(s)) await opts.nth(i).click().catch(() => {});
    }
  } else if (c) {
    await opts.nth(0).click().catch(() => {});
  }
  await p.waitForTimeout(400);
  const btns = p.locator('.action-row > button');
  const bc = await btns.count();
  const labels = await btns.allInnerTexts().catch(() => []);
  console.log('Q' + n, type, 'tips', tips.length, 'btns', JSON.stringify(labels));
  if (labels.some(l => l.includes('交'))) {
    console.log('SUBMIT available');
    break;
  }
  if (!(await btns.first().isDisabled().catch(() => true))) { await btns.first().click(); await p.waitForTimeout(1200); }
}
await b.close();
