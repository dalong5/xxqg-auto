import fs from 'node:fs';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
for (const u of ['https://pc.xuexi.cn/points/study-login/login.0d1b2856.js','https://pc.xuexi.cn/points/study-login/vendors.1c4acf64.js']){
 try{const r=await fetch(u,{headers:{'user-agent':ua,'referer':'https://pc.xuexi.cn/points/login.html'}});const t=await r.text();
 const f='xxqg/research/'+u.split('/').pop(); fs.writeFileSync(f,t); console.log('OK',f,r.status,t.length)}catch(e){console.log('ERR',u,e.message)}
}
