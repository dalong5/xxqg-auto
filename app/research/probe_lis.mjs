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
for (let n = 1; n <= 12; n++) {
  const btn = p.locator('.action-row button').first();
  for (let k = 0; k < 12; k++) {
    if (!(await btn.isDisabled().catch(() => true))) break;
    const opts = p.locator('.q-answer.choosable');
    const c = await opts.count();
    if (c) await opts.nth(k % c).click({ force: true }).catch(() => {});
    else {
      const chips = p.locator('.fill-answer');
      const cn = await chips.count();
      if (cn) { await p.locator('.click-box').first().click({ force: true }).catch(() => {}); await chips.nth(k % cn).click({ force: true }).catch(() => {}); }
      else { const inp = p.locator('.q-body input'); if (await inp.count()) await inp.first().fill('无').catch(() => {}); }
    }
    await p.waitForTimeout(300);
  }
  console.log('Q' + n, 'disabled=', await btn.isDisabled().catch(() => 'na'));
  await btn.click({ force: true }).catch(() => {});
  for (let k = 0; k < 20; k++) {
    if (await p.locator('#JS_aliyun-captcha-dialog.show').count()) break;
    if ((await btn.innerText().catch(() => '')).includes('完')) break;
    await p.waitForTimeout(400);
  }
  if (await p.locator('#JS_aliyun-captcha-dialog.show').count()) break;
  if ((await btn.innerText().catch(() => '')).includes('完')) break;
}
console.log('final label:', (await p.locator('.action-row button').first().innerText().catch(()=>'')));
console.log('dialog:', await p.locator('#JS_aliyun-captcha-dialog.show').count());
console.log('url', p.url());

const cdp = await ctx.newCDPSession(p);
async function listeners(sel) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  if (!nodeId) return sel + ': none';
  const { object } = await cdp.send('DOM.resolveNode', { nodeId });
  const res = await cdp.send('DOMDebugger.getEventListeners', { objectId: object.objectId });
  return sel + ': ' + res.listeners.map((l) => l.type).join(',');
}
await p.locator('.action-row button').first().click({ force: true }).catch(() => {});
await p.waitForTimeout(2500);
console.log('iframes', await p.evaluate(() => document.querySelectorAll('iframe').length), 'src', await p.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src).join(',')));
console.log('aliyunCaptcha?', await p.evaluate(() => typeof window.aliyunCaptcha));
for (let t = 0; t < 3; t++) {
  console.log('round', t, 'dialog', await p.locator('#JS_aliyun-captcha-dialog.show').count());
  if (!(await p.locator('#JS_aliyun-captcha-dialog.show').count())) break;
  await p.locator('#JS_aliyun-captcha-close-btn').click().catch(() => {});
  await p.waitForTimeout(600);
  await p.locator('.action-row button').first().click({ force: true }).catch(() => {});
  await p.waitForTimeout(2500);
}
console.log('url', p.url());
console.log('body tail:', (await p.evaluate(() => document.body.innerText)).slice(-200).replace(/\n+/g, ' | '));
console.log('score:', await p.evaluate(async () => (await (await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' })).text()).slice(0, 120)));
console.log('body:', (await p.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n+/g, ' | '));
console.log('score:', await p.evaluate(async () => (await (await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' })).text()).slice(0, 300)));
await b.close();
console.log('listeners', await listeners('#aliyunCaptcha-sliding-slider'));
// 关掉验证码，直接点完成
await p.locator('#JS_aliyun-captcha-close-btn').click().catch(() => {});
await p.waitForTimeout(700);
console.log('after close dialog:', await p.locator('#JS_aliyun-captcha-dialog.show').count());
await p.locator('.action-row button').first().click({ force: true }).catch(() => {});
await p.waitForTimeout(3000);
console.log('body:', (await p.evaluate(() => document.body.innerText)).slice(0, 260).replace(/\n+/g, ' | '));
console.log('modal:', await p.locator('.ant-modal').count());
if (await p.locator('.ant-modal').count()) {
  console.log('modalHTML:', (await p.locator('.ant-modal').first().innerText()).slice(0, 200).replace(/\n+/g, ' | '));
  await p.locator('.ant-modal button').last().click().catch(() => {});
  await p.waitForTimeout(2500);
  console.log('after confirm body:', (await p.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n+/g, ' | '));
}
const r = await p.evaluate(async () => {
  const res = await fetch('https://pc-proxy-api.xuexi.cn/delegate/score/today/query?deviceType=2', { credentials: 'include' });
  return (await res.text()).slice(0, 300);
});
console.log('score api:', r);
await b.close();