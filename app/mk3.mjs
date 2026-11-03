import fs from 'node:fs';
let c = fs.readFileSync('probe_vp.mjs', 'utf8');
c = c.replace("headless: true, args: ['--window-size=1440,900'] });", "headless: false, args: ['--window-size=1440,940', '--window-position=0,0'] });");
fs.writeFileSync('probe_hd.mjs', c);
console.log('ok');