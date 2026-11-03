import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
const p = await ctx.newPage();
const hits = [];
p.on('request', r => {
  const u = r.url();
  if (/study|delegate|duration|article|progress|report|score|log/i.test(u) && !/\.(png|jpg|css|woff)/.test(u)) hits.push(r.method() + ' ' + u.slice(0, 150));
});
await p.goto('https://www.xuexi.cn/lgpage/detail/index.html?id=1' , { waitUntil: 'domcontentloaded' }).catch(()=>{});
const feed = await (await fetch('https://www.xuexi.cn/lgdata/35il6fpn0ohq.json?x=' + Date.now(), { headers: { 'user-agent': 'Mozilla/5.0 Chrome/131' } })).json();
const item = feed.find(i => i.url);
console.log('article:', item.url, item.title?.slice(0, 30));
await p.goto(item.url, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);
console.log('visibility:', await p.evaluate(() => document.visibilityState));
console.log('url:', p.url());
const info = await p.evaluate(() => ({
  hasStudySdk: !!window.__STUDY__ || !!window.studyTime || !!window.reportStudy,
  keys: Object.keys(window).filter(k => /stud|auer|report|score|time/i.test(k)).slice(0, 20),
  scripts: [...document.scripts].map(s => s.src).filter(Boolean).slice(0, 12),
}));
console.log(JSON.stringify(info, null, 1));
for (let i = 0; i < 14; i++) { await p.mouse.wheel(0, 600); await p.waitForTimeout(5000); }
console.log('--- requests ---');
console.log(hits.slice(0, 25).join('\n') || '(none)');
await b.close();
