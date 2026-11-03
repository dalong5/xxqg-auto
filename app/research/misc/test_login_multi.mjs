const base='http://127.0.0.1:8099';
let cookie='';
const h=()=>({'content-type':'application/json',cookie});
let r = await fetch(base+'/api/me',{headers:h()}); const j=await r.json();
cookie = r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
console.log('me:', j);

// 同时开 3 个扫码会话
const sids = await Promise.all([1,2,3].map(async()=> (await (await fetch(base+'/api/login/start',{method:'POST',headers:h()})).json()).sid));
console.log('sids:', sids.length, sids[0].slice(0,8));
await new Promise(r=>setTimeout(r,3000));
for (const sid of sids) {
  const st = await (await fetch(`${base}/api/login/${sid}`,{headers:h()})).json();
  console.log(sid.slice(0,8), 'status=', st.status, 'qrLen=', st.qr?.length);
}
// 串号检查：另一个没用 cookie 的会话应该读不到
const other = await fetch(`${base}/api/login/${sids[0]}`); console.log('no-cookie read:', (await other.json()).error);
