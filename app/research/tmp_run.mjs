import crypto from 'node:crypto';
import fs from 'node:fs';
const key = Buffer.from(fs.readFileSync('data/secret.key', 'utf8').trim(), 'hex');
const uid = process.argv[2];
const tasks = process.argv[3].split(',');
const { DatabaseSync } = await import('node:sqlite');
const d = new DatabaseSync('data/app.db');
const v = d.prepare('select visitor_id from users where uid=?').get(uid).visitor_id;
const cookie = `xxqg_v=${encodeURIComponent(v + '.' + crypto.createHmac('sha256', key).update(v).digest('base64url').slice(0, 22))}`;
const base = 'http://127.0.0.1:8099';
const h = { cookie, 'content-type': 'application/json' };
const job = (await (await fetch(`${base}/api/users/${uid}/run`, { method: 'POST', headers: h, body: JSON.stringify({ tasks }) })).json()).jobId;
const t0 = Date.now();
const es = await fetch(`${base}/api/jobs/${job}/events`, { headers: h });
const reader = es.body.getReader();
const dec = new TextDecoder();
let buf = '';
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value);
  const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines) {
    if (!l.startsWith('data:')) continue;
    const e = JSON.parse(l.slice(5));
    const at = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
    if (e.type === 'log') console.log(at, e.payload.text);
    if (e.type === 'score') console.log(at, '分数', e.payload.today, '/', e.payload.total, JSON.stringify(e.payload.tasks));
    if (e.type === 'start') console.log(at, 'start', JSON.stringify(e.payload));
    if (e.type === 'error') console.log(at, 'ERROR', e.payload.error);
  }
  if (buf.includes('event: end')) break;
}
console.log('done');
