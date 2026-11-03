import fs from 'node:fs';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const u='https://www.xuexi.cn/lgpage/detail/index.html?id=8210705700694263975&item_id=8210705700694263975';
const r=await fetch(u,{headers:{'user-agent':ua}});
const t=await r.text(); fs.writeFileSync('data/article.html',t);
console.log(r.status,t.length);
for(const m of t.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) console.log('JS',m[1]);
for(const m of t.matchAll(/https?:\/\/[a-z0-9.-]+\.xuexi\.cn\/[^\s"'`]+/g)) console.log('URL',m[0].slice(0,120));
