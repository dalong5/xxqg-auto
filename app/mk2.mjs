import fs from 'node:fs';
let c = fs.readFileSync('probe_ua.mjs', 'utf8');
c = c.replace("const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, userAgent: UA });", "const ctx = await b.newContext({ locale: 'zh-CN', userAgent: UA });");
c = c.replace("headless: true });", "headless: true, args: ['--window-size=1440,900'] });");
c = c.replace("console.log('GEO slider'", "console.log('WIN', JSON.stringify(await p.evaluate(() => [innerWidth, innerHeight, outerWidth, outerHeight, screen.width, screen.height, devicePixelRatio])));\nconsole.log('GEO slider'");
fs.writeFileSync('probe_vp.mjs', c);
console.log('ok');