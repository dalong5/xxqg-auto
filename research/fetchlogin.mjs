import fs from 'node:fs';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
try{
 const r=await fetch('https://pc.xuexi.cn/points/login.html',{headers:{'user-agent':ua}});
 const t=await r.text(); fs.writeFileSync('xxqg/research/login.html',t);
 console.log('status',r.status,'len',t.length);
}catch(e){console.log('ERR',e.message)}
