import { chromium } from 'playwright';
const list = (await import('node:fs')).readFileSync('px.txt', 'utf8').split(/\s+/).filter(Boolean).slice(0, 9);
for (const px of list) {
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--proxy-server=http://' + px] });
  const p = await (await b.newContext()).newPage();
  const t0 = Date.now();
  const r = await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded', timeout: 25000 }).then((x) => 'ok ' + x.status()).catch((e) => 'err');
  console.log(px, r, Date.now() - t0 + 'ms');
  await b.close();
}