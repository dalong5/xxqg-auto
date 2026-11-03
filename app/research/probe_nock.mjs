import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on('response', async (r) => {
  if (r.url().includes('quizSubmitV3')) console.log('SUBMIT', r.status(), (await r.text().catch(() => '')).slice(0, 260));
});
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3000);
const btn = p.locator('.action-row button').first();
for (let n = 0; n < 22; n++) {
  const lb = (await btn.innerText().catch(() => '')).replace(/\s+/g, '');
  if (lb.includes('完') || lb.includes('交')) break;
  for (let k = 0; k < 12; k++) {
    if (!(await btn.isDisabled().catch(() => true))) break;
    const opts = p.locator('.q-answer.choosable');
    const c = await opts.count();
    if (c) await opts.nth(k % c).click({ force: true }).catch(() => {});
    else { const inp = p.locator('.q-body input'); if (await inp.count()) await inp.first().fill('无').catch(() => {}); }
    await p.waitForTimeout(140);
  }
  await btn.click({ force: true }).catch(() => {});
  await p.waitForTimeout(700);
}
console.log('label', (await btn.innerText().catch(() => '')).replace(/\s+/g, ''));
await ctx.clearCookies({ name: 'abnormal_exam' });
console.log('cookie left', JSON.stringify((await ctx.cookies()).map((c) => c.name)));
await btn.click({ force: true }).catch(() => {});
await p.waitForTimeout(4500);
console.log('dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
console.log('body', (await p.evaluate(() => document.body.innerText)).slice(-160).replace(/\n+/g, ' | '));
console.log('score', await p.evaluate(async () => (await (await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' })).text()).slice(0, 130)));
await b.close();