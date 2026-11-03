import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1180, height: 940 }, locale: 'zh-CN' });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console ' + m.text()); });

await p.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });
console.log('rows:', (await p.locator('#rows').innerText()).replace(/\n/g,' '));

await p.click('#btnLogin');
await p.locator('#qrbox img').waitFor({ timeout: 25000 });
const src = await p.locator('#qrbox img').getAttribute('src');
console.log('qr shown:', src.startsWith('data:image/png;base64,'));

await p.click('#btnSelf');
await p.waitForFunction(() => document.querySelector('#log').textContent.includes('任务结束'), null, { timeout: 60000 });
console.log('log:', (await p.locator('#log').innerText()).split('\n').slice(-4).join(' | '));
await p.screenshot({ path: 'data/ui-single.png' });
console.log('errs:', errs.length ? errs.join(' ; ') : 'none');
await b.close();
