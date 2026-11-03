import fs from 'node:fs';
import crypto from 'node:crypto';
const buf = fs.readFileSync('verify_data.bin');
const ks = '3b9a635762387200';
const keys = {
  utf8: Buffer.from(ks, 'utf8'),
  hexpad: Buffer.concat([Buffer.from(ks, 'hex'), Buffer.alloc(8)]),
  md5: crypto.createHash('md5').update(ks).digest(),
  sha256: crypto.createHash('sha256').update(ks).digest(),
};
const ivs = { first16: buf.slice(0, 16), zero: Buffer.alloc(16) };
for (const [kn, key] of Object.entries(keys)) {
  const algos = key.length === 16 ? ['aes-128-cbc', 'aes-128-ecb', 'aes-128-ctr'] : ['aes-256-cbc', 'aes-256-ecb', 'aes-256-ctr'];
  for (const alg of algos) {
    const cbc = alg.endsWith('cbc');
    for (const [ivn, iv] of Object.entries(ivs)) {
      if (!cbc && ivn === 'zero' && false) continue;
      const ct = cbc ? buf.slice(16) : buf;
      try {
        const d = crypto.createDecipheriv(alg, key, cbc ? iv : null);
        const out = Buffer.concat([d.update(ct), d.final()]);
        const txt = out.toString('utf8');
        if (/^[\[{]/.test(txt) || txt.includes('{')) console.log('HIT', kn, alg, ivn, JSON.stringify(txt.slice(0, 100)));
        else console.log('ok ', kn, alg, ivn, JSON.stringify(txt.slice(0, 60)));
      } catch (e) { /* padding */ }
    }
  }
}