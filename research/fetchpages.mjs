import fs from 'node:fs';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const list=[['https://www.php.cn/faq/2234007.html','p1.html'],['https://m.xgnews.cn/p/126928.html','p2.html']];
for(const [u,f] of list){try{const r=await fetch(u,{headers:{'user-agent':ua}});const buf=Buffer.from(await r.arrayBuffer());
 // try utf8 / gbk
 let t=buf.toString('utf8'); fs.writeFileSync('xxqg/research/'+f,t); console.log('OK',f,r.status,t.length);
}catch(e){console.log('ERR',u,e.message)}}
