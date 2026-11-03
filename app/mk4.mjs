import fs from 'node:fs';
let c = fs.readFileSync('probe_vp.mjs', 'utf8');
c = c.replace("args: ['--window-size=1440,900'] });", "args: ['--disable-blink-features=AutomationControlled'] });");
c = c.replace("await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); });", "");
c = c.replace("console.log('WIN'", "console.log('WD', await (async () => 0)());\nconsole.log('WIN'");
fs.writeFileSync('probe_ac.mjs', c);
console.log('ok');