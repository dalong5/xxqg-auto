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
for (let n = 1; n <= 16; n++) {
  const type = (await p.locator('.q-header').first().innerText().catch(() => '')).replace(/\s+/g, '');
  if (type.includes('点选')) {
    console.log('FOUND');
    console.log((await p.evaluate(() => document.querySelector('.question')?.outerHTML || 'none')).slice(0, 3000));
    console.log('--- click blank 1 ---');
    await p.locator('.click-box').first().click().catch(e => console.log('err', e.message.slice(0, 60)));
    await p.waitForTimeout(1500);
    console.log((await p.evaluate(() => document.querySelector('.question')?.outerHTML || 'none')).slice(0, 3000));
    break;
  }
  await p.locator('.tips').first().click().catch(() => {});
  await p.waitForTimeout(500);
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
  }
  await p.waitForTimeout(300);
  const btns = p.locator('.action-row > button');
  const labels = await btns.allInnerTexts().catch(() => []);
  if (labels.some(l => l.includes('交'))) break;
  if (!(await btns.first().isDisabled().catch(() => true))) { await btns.first().click(); await p.waitForTimeout(2200); }
}
await b.close();
