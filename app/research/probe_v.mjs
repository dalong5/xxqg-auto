import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })).newPage();
const feed = await (await fetch('https://www.xuexi.cn/lgdata/3j2u3cttsii9.json?x=' + Date.now(), { headers: { 'user-agent': 'Mozilla/5.0 Chrome/131' } })).json();
const item = feed.find(i => i.url);
console.log('video:', item.url);
await p.goto(item.url, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
const before = await p.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { found: true, duration: v.duration, paused: v.paused, muted: v.muted, ct: v.currentTime, autoplay: v.autoplay, src: (v.currentSrc||'').slice(0,60) } : { found: false, iframes: document.querySelectorAll('iframe').length };
});
console.log('video state:', JSON.stringify(before));
if (before.found) {
  await p.evaluate(() => { const v = document.querySelector('video'); v.muted = true; return v.play().catch(() => {}); });
}
await p.waitForTimeout(8000);
console.log('after play:', JSON.stringify(await p.evaluate(() => { const v = document.querySelector('video'); return v ? { paused: v.paused, ct: v.currentTime } : null; })));
await b.close();
