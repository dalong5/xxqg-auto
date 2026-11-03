import crypto from 'node:crypto';
const arg = Buffer.from('GCMSM1gPeDAxFw==', 'base64');
const ks = '3b9a635762387200';
const keys = [Buffer.from(ks, 'utf8'), Buffer.from(ks, 'utf8').subarray(0, 8), Buffer.from(ks, 'hex')];
for (const key of keys) {
  for (const alg of ['aes-128-ecb', 'des-ecb', 'des-ede-ecb', 'aes-128-cbc']) {
    try {
      const d = crypto.createDecipheriv(alg, key, alg.includes('cbc') ? Buffer.alloc(16) : null);
      d.setAutoPadding(false);
      const o = Buffer.concat([d.update(arg), d.final()]);
      console.log(alg, key.length, o.toString('hex'), JSON.stringify(o.toString('latin1')));
    } catch (e) { console.log(alg, key.length, 'ERR'); }
  }
}