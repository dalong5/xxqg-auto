import crypto from 'node:crypto';
import fs from 'node:fs';
const key = Buffer.from(fs.readFileSync('data/secret.key', 'utf8').trim(), 'hex');
const uid = process.argv[2];
const { DatabaseSync } = await import('node:sqlite');
const d = new DatabaseSync('data/app.db');
const v = d.prepare('select visitor_id from users where uid=?').get(uid).visitor_id;
const mac = crypto.createHmac('sha256', key).update(v).digest('base64url').slice(0, 22);
const cookie = `xxqg_v=${encodeURIComponent(v + '.' + mac)}`;
const base = 'http://127.0.0.1:8099';
const h = { cookie, 'content-type': 'application/json' };

const me = await (await fetch(base + '/api/me', { headers: h })).json();
console.log('me.ok', me.accounts);
const job = (await (await fetch(`${base}/api/users/${uid}/sync`, { method: 'POST', headers: h })).json()).jobId;
const es = await fetch(`${base}/api/jobs/${job}/events`, { headers: h });
const reader = es.body.getReader();
const dec = new TextDecoder();
let out = '';
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  out += dec.decode(value);
  if (out.includes('event: end')) break;
}
console.log(out.split('\n').filter(l => l.startsWith('data:')).join('\n'));
