import { chromium } from 'playwright';
for (const px of ['122.246.4.30:17981', '36.213.79.159:1081']) {
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--proxy-server=http://' + px] });
  const p = await (await b.newContext()).newPage();
  for (const u of ['https://ipinfo.io/json', 'https://pc.xuexi.cn/points/my-points.html']) {
    const t0 = Date.now();
    const r = await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).then((x) => 'ok ' + x.status()).catch((e) => 'err ' + e.message.slice(0, 40));
    console.log(px, u.slice(8, 30), r, Date.now() - t0 + 'ms');
  }
  await b.close();
}