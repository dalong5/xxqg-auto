const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const jar = new Map();
const hdr = { 'user-agent': ua, referer: 'https://pc.xuexi.cn/points/login.html', accept: 'application/json' };
function saveCookies(r){ for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0,i), kv.slice(i+1)); } }
function cookieHeader(){ return [...jar].map(([k,v])=>`${k}=${v}`).join('; '); }

let r = await fetch('https://pc-api.xuexi.cn/open/api/sns/sign', { headers: { ...hdr, cookie: cookieHeader() } });
saveCookies(r);
console.log('sign status', r.status, await r.text());

r = await fetch('https://login.xuexi.cn/user/qrcode/generate', { headers: { ...hdr, cookie: cookieHeader() } });
saveCookies(r);
const g = await r.text();
console.log('generate', r.status, g);
const result = JSON.parse(g).result;

for (let i = 0; i < 2; i++) {
  const body = new URLSearchParams({ qrCode: result, goto: 'https://oa.xuexi.cn', pdmToken: '' });
  const p = await fetch('https://login.xuexi.cn/login/login_with_qr', { method: 'POST', headers: { ...hdr, cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body });
  saveCookies(p);
  console.log('poll', p.status, await p.text());
  await new Promise(res => setTimeout(res, 2500));
}
console.log('qr url =', 'https://login.xuexi.cn/login/qrcommit?showmenu=false&code=' + encodeURIComponent(result) + '&appId=dingoankubyrfkttorhpou');
console.log('cookies =', cookieHeader());
