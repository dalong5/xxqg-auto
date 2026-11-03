import fs from 'node:fs';
import crypto from 'node:crypto';
const raw = fs.readFileSync('verify_req.json', 'utf8');
const params = new URLSearchParams(raw);
console.log('keys', [...params.keys()].join(','));
const cvp = params.get('CaptchaVerifyParam');
const inner = JSON.parse(decodeURIComponent(cvp));
console.log('inner keys', Object.keys(inner).join(','));
const data = inner.data;
console.log('data len', data && data.length, 'head', data && data.slice(0, 24));
const buf = Buffer.from(data, 'base64');
fs.writeFileSync('verify_data.bin', buf);
console.log('bytes', buf.length, buf.slice(0, 16).toString('hex'));
for (const keyStr of ['3b9a635762387200']) {
  const key = Buffer.from(keyStr, 'utf8');
  for (const mode of ['aes-128-cbc', 'aes-128-ecb']) {
    for (const ivOff of [0, 8, 16]) {
      try {
        const iv = mode.endsWith('cbc') ? buf.slice(0, 16) : null;
        const body = mode.endsWith('cbc') ? buf.slice(ivOff + 16, ivOff + 16 + (buf.length - ivOff - 16 - ((buf.length - ivOff - 16) % 16))) : buf.slice(ivOff, ivOff + (buf.length - ivOff - ((buf.length - ivOff) % 16)));
        if (!body.length) continue;
        const d = crypto.createDecipheriv(mode, key, iv);
        const out = Buffer.concat([d.update(body), d.final()]);
        const txt = out.toString('utf8');
        const printable = txt.replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, '').length / txt.length;
        console.log(mode, 'ivOff', ivOff, 'ratio', printable.toFixed(2), JSON.stringify(txt.slice(0, 120)));
      } catch (e) { console.log(mode, 'ivOff', ivOff, 'ERR', e.message.slice(0, 30)); }
    }
  }
}