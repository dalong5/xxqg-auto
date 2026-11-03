import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN' });
const p = await ctx.newPage();
const seen = new Set();
p.on('request', r => { if (r.url().includes('login.xuexi.cn')) seen.add(r.method() + ' ' + r.url()); });
await p.goto('https://pc.xuexi.cn/points/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(12000);
console.log([...seen].join('\n'));
const f = p.frames().find(x => x.url().includes('xuexiWeb'));
if (f) { const html = await f.content(); (await import('node:fs')).writeFileSync('data/qgiframe.html', html); console.log('iframe html len', html.length); }
await b.close();
