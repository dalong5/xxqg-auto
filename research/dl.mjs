import fs from 'node:fs';
const files=[
 ['https://raw.githubusercontent.com/LossInWind/xxqg-helper/master/README.md','xxqg/research/helper_readme.md'],
 ['https://raw.githubusercontent.com/sjkhsl/study_xxqg/main/README.md','xxqg/research/study_readme.md'],
];
for(const [u,f] of files){try{const r=await fetch(u);const t=await r.text();fs.writeFileSync(f,t);console.log('OK',f,t.length)}catch(e){console.log('ERR',f,e.message)}}
