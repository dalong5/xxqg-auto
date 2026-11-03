import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1180, height: 960 }, locale: 'zh-CN' });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });
await p.click('#btnSync');                       // 未登录点查分
await p.waitForTimeout(600);
console.log('sync guard:', (await p.locator('#log').innerText()).includes('请先扫码登录'));
await p.click('#btnLogin');
await p.locator('#qrbox img').waitFor({ timeout: 25000 });
await p.waitForTimeout(1200);
await p.screenshot({ path: 'data/ui-final.png' });
console.log('hint:', (await p.locator('#loginmsg').innerText()).slice(0, 30));
console.log('errs:', errs.length ? errs.join(' ; ') : 'none');
await b.close();
