const qs = [
 'https://api.github.com/search/repositories?q=%E5%AD%A6%E4%B9%A0%E5%BC%BA%E5%9B%BD&sort=updated&order=desc&per_page=15',
 'https://api.github.com/search/repositories?q=xuexi+qiangguo&sort=updated&order=desc&per_page=15',
];
for (const u of qs) {
  const r = await fetch(u, {headers:{'User-Agent':'node','Accept':'application/vnd.github+json'}});
  const j = await r.json();
  console.log('==', u, r.status);
  for (const it of (j.items||[])) console.log(new Date(it.updated_at).toISOString().slice(0,10), String(it.stargazers_count).padStart(5), it.full_name, '|', (it.description||'').slice(0,60));
}
