const repos = ['TechXueXi/techxuexi-js','AutoXuexiPlaywright/AutoXuexiPlaywright','Xu22Web/tech-study-node','dundunnp/auto_xuexiqiangguo'];
for (const r of repos) {
  for (const br of ['main','master']) {
    const res = await fetch(`https://codeload.github.com/${r}/zip/refs/heads/${br}`);
    if (res.ok) { const b=Buffer.from(await res.arrayBuffer()); const f='xxqg/research/'+r.split('/')[1]+'.zip'; require('fs').writeFileSync(f,b); console.log('OK',r,br,b.length); break; }
    else console.log('miss',r,br,res.status);
  }
}
