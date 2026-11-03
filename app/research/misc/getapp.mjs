import fs from 'node:fs';
for (const u of ['https://assets.xuexi.cn/party-login-qr/1.0.6/js/app.js']) {
  const r = await fetch(u); const t = await r.text();
  fs.writeFileSync('data/app.js', t); console.log(r.status, t.length);
}
