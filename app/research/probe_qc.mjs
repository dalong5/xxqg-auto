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
  await p.waitForTimeout(500);
  const info = await p.evaluate(() => ({
    rows: [...document.querySelectorAll('.action-row')].map(r => r.outerHTML.slice(0, 300)),
    modal: document.querySelector('.ant-modal')?.outerHTML.slice(0, 300) || null,
    bodyCls: document.body.className,
    pager: document.querySelector('.q-pager, .exam-progress, .progress')?.innerText || null,
  }));
  console.log('Q' + n, type, JSON.stringify(info));
  const next = p.locator('.action-row > button').first();
  if (await next.isDisabled().catch(() => true)) { console.log(' disabled'); break; }
  await next.click().catch(e => console.log('clickerr', e.message.slice(0, 60)));
  await p.waitForTimeout(2500);
  if (!(await p.locator('.q-body').count())) { console.log('left exam'); break; }
}
console.log('URL', p.url());
await p.waitForTimeout(3000);
console.log('BODY', (await p.evaluate(() => document.body.innerText)).slice(0, 500));
await b.close();
