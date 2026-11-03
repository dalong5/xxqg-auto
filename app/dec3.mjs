import fs from 'node:fs';
import crypto from 'node:crypto';
console.log('START');
const buf = fs.readFileSync('verify_data.bin');
const ks = '3b9a635762387200';
const variants = [
  ['utf8', Buffer.from(ks, 'utf8'), 128],
  ['hexpad', Buffer.concat([Buffer.from(ks, 'hex'), Buffer.alloc(8)]), 128],
  ['md5', crypto.createHash('md5').update(ks).digest(), 128],
  ['sha256', crypto.createHash('sha256').update(ks).digest(), 256],
];
for (const [kn, key, bits] of variants) {
  for (const mode of ['cbc', 'ecb', 'ctr']) {
    for (const ivName of ['first16', 'zero']) {
      const alg = `aes-${bits}-${mode}`;
      const iv = mode === 'cbc' ? (ivName === 'first16' ? buf.subarray(0, 16) : Buffer.alloc(16)) : Buffer.alloc(0);
      const ct = mode === 'cbc' ? buf.subarray(16) : buf;
      try {
        const d = crypto.createDecipheriv(alg, key, mode === 'ecb' ? null : iv);
        const out = Buffer.concat([d.update(ct), d.final()]);
        const txt = out.toString('utf8');
        console.log('TRY', kn, alg, ivName, JSON.stringify(txt.slice(0, 80)));
      } catch (e) {
        console.log('ERR', kn, alg, ivName, e.message.slice(0, 40));
      }
    }
  }
}
console.log('END');