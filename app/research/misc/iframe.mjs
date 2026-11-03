import fs from 'node:fs';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const state = fs.readFileSync('data/state.txt','utf8').trim();
const u = `https://login.xuexi.cn/login/xuexiWeb?appid=dingoankubyrfkttorhpou&goto=https%3A%2F%2Foa.xuexi.cn&type=1&state=${state}`;
const r = await fetch(u,{headers:{'user-agent':ua}});
const t = await r.text();
fs.writeFileSync('data/qgiframe.html', t);
console.log(r.status, t.length);
for (const m of t.matchAll(/(?:src|href)="([^"]+)"/g)) console.log('ASSET', m[1]);
