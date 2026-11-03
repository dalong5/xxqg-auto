import fs from 'node:fs';
const t = fs.readFileSync('examp.js', 'utf8');
const hosts = new Set(t.match(/https:\/\/[a-z0-9.\-]*xuexi\.cn/g) || []);
console.log([...hosts].join('\n'));
const i = t.indexOf('detectRisk');
console.log('detectRisk at', i);
if (i > 0) console.log(t.slice(i - 300, i + 200));