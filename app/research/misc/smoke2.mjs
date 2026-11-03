import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';
const profile = 'data/chrome-profile';
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu',
  '--remote-debugging-port=9222', `--user-data-dir=${profile}`,
  '--window-size=460,700','about:blank'
], { stdio: 'ignore', detached: true });
chrome.unref();
let ok = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch('http://127.0.0.1:9222/json/version'); if (r.ok) { console.log('cdp up', (await r.json()).Browser); ok = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 500));
}
if (!ok) { console.log('cdp failed'); process.exit(1); }
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0] || await b.newContext();
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(7000);
console.log('title=', await p.title());
console.log('frames=', p.frames().map(f => f.url().slice(0, 120)));
const box = p.locator('.qrcode-box');
console.log('box count=', await box.count());
if (await box.count()) { await box.first().screenshot({ path: 'data/shot-qr.png' }); console.log('qr shot saved'); }
await b.close();
