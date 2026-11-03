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
await p.waitForTimeout(3000);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(4000);
for (let n = 1; n <= 6; n++) {
  const body = p.locator('.q-body').first();
  if (!(await body.count())) { console.log('no body'); break; }
  const type = (await p.locator('.q-header').first().innerText()).replace(/\s+/g, '');
  console.log('Q' + n, type);
  if (type.includes('点选')) {
    console.log(await body.innerHTML());
    break;
  }
  const tips = await (async () => {
    await p.locator('.tips').first().click().catch(() => {});
    await p.waitForTimeout(700);
    const html = await p.locator('.ant-popover .line-feed').first().innerHTML().catch(() => '');
    await p.mouse.click(20, 20).catch(() => {});
    return [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)].map(m => m[1].trim());
  })();
  console.log(' tips', JSON.stringify(tips));
  if (type.includes('填空')) {
    const inputs = p.locator('.q-body input');
    const c = await inputs.count();
    console.log(' inputs', c);
    for (let i = 0; i < c; i++) if (tips[i]) await inputs.nth(i).fill(tips[i]).catch(() => {});
  } else {
    const opts = p.locator('.q-answer.choosable');
    const c = await opts.count();
    for (const t of tips) for (let i = 0; i < c; i++) {
      const s = (await opts.nth(i).innerText()).trim().replace(/^[A-Z][.、]\s*/, '').replace(/\s+/g, '');
      if (t.replace(/\s+/g, '').includes(s) || s.includes(t.replace(/\s+/g, ''))) await opts.nth(i).click().catch(() => {});
    }
  }
  await p.waitForTimeout(400);
  const btn = p.locator('.action-row > button').first();
  console.log(' disabled', await btn.isDisabled().catch(() => 'n/a'));
  if (!(await btn.isDisabled().catch(() => true))) { await btn.click(); await p.waitForTimeout(1500); }
}
await b.close();
