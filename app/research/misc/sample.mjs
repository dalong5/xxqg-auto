const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const r = await fetch('https://www.xuexi.cn/lgdata/35il6fpn0ohq.json?_st=12345678', { headers: { 'user-agent': ua } });
const j = await r.json();
console.log('items', j.length, 'sample', JSON.stringify(j[0]).slice(0,300));
