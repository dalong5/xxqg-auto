import fs from 'node:fs';
const urls=[
 ['https://codeload.github.com/LossInWind/xxqg-helper/zip/refs/heads/master','xxqg/research/helper.zip'],
 ['https://codeload.github.com/sjkhsl/study_xxqg/zip/refs/heads/master','xxqg/research/study.zip'],
 ['https://codeload.github.com/TechXueXi/TechXueXi/zip/refs/heads/master','xxqg/research/techxuexi.zip'],
];
for(const [u,f] of urls){try{const r=await fetch(u);if(!r.ok){console.log('HTTP',r.status,u);continue}const b=Buffer.from(await r.arrayBuffer());fs.writeFileSync(f,b);console.log('OK',f,b.length)}catch(e){console.log('ERR',u,e.message)}}
