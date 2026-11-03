import fs from 'node:fs';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const r=await fetch('https://www.xuexi.cn/lgpage/common/vendor.4c6de0.js',{headers:{'user-agent':ua}});
const t=await r.text(); fs.writeFileSync('data/vendor.js',t); console.log(r.status,t.length);
