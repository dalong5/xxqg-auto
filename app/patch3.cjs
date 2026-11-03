const fs = require('fs');
let t = fs.readFileSync('probe_len2.mjs', 'utf8');
t = t.replace("const box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox();", "await p.waitForSelector('#aliyunCaptcha-sliding-slider', { timeout: 15000 }).catch(() => console.log('no slider'));\nconst box = await p.locator('#aliyunCaptcha-sliding-slider').boundingBox();");
t = t.replace("await run(0);\nawait run(5);\nawait run(60);", "await run(0);\nawait p.waitForTimeout(1500);\nawait run(5);\nawait p.waitForTimeout(1500);\nawait run(60);");
fs.writeFileSync('probe_len3.mjs', t);
console.log('ok');
