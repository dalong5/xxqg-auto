import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--proxy-server=http://36.213.79.159:1081'] });
const p = await (await b.newContext()).newPage();
const t0 = Date.now();
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('nav', e.message.slice(0, 80)));
console.log('load ms', Date.now() - t0, 'title', (await p.title().catch(() => '')).slice(0, 30));
console.log('body', (await p.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 80).replace(/\n+/g, ' '));
await b.close();