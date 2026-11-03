import fs from 'node:fs';
let t = fs.readFileSync('docs/PROGRESS.md', 'utf8');
t = t.slice(0, 1674).replace(/\s+$/, '') + '\n';
fs.writeFileSync('docs/PROGRESS.md', t, 'utf8');
console.log('trimmed', t.length, JSON.stringify(t.slice(-40)));