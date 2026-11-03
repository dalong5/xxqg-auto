import fs from 'node:fs';
import crypto from 'node:crypto';
const buf = fs.readFileSync('verify_data.bin');
const ks = '3b9a635762387200';
const iv0 = buf.subarray(0, 8);
const iv16 = buf.subarray(0, 16);
const combos = [
  ['des-cbc', Buffer.from(ks, 'utf8').subarray(0, 8), iv0, 8],
  ['des-ecb', Buffer.from(ks, 'utf8').subarray(0, 8), null, 0],
  ['des-ede-cbc', Buffer.from(ks, 'utf8'), iv0, 8],
  ['des-ede3-cbc', Buffer.from(ks, 'utf8'), iv0, 8],
  ['rc4', Buffer.from(ks, 'utf8'), null, 0],
  ['rc4', crypto.createHash('md5').update(ks).digest(), null, 0],
];
for (const [alg, key, iv, off] of combos) {
  try {
    const d = crypto.createDecipheriv(alg, key, iv);
    d.setAutoPadding(false);
    const out = Buffer.concat([d.update(buf.subarray(off)), d.final()]);
    const txt = out.toString('utf8').replace(/\0+$/, '');
    const good = txt.replace(/[^\x20-\x7e]/g, '').length / Math.max(1, txt.length);
    console.log(alg, key.length, 'ratio', good.toFixed(2), JSON.stringify(txt.slice(0, 90)));
  } catch (e) { console.log(alg, 'ERR', e.message.slice(0, 40)); }
}