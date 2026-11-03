const fs = require('fs');
let t = fs.readFileSync('probe_len.mjs', 'utf8');
t = "import crypto from 'node:crypto';\n" + t.replace("require('node:crypto')", 'crypto');
fs.writeFileSync('probe_len2.mjs', t);
console.log('ok');
