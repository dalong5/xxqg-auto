import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN' });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
await p.goto('https://pc.xuexi.cn/points/exam-practice.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);
console.log('mod', await p.evaluate(() => typeof window.XXQG_EXAM_ALIYUN_FP_UM_MODULE));
const tok = await p.evaluate(() => { try { return window.XXQG_EXAM_ALIYUN_FP_UM_MODULE?.getToken() || ''; } catch (e) { return 'ERR ' + e.message; } });
console.log('token len', String(tok).length, String(tok).slice(0, 60));
console.log('detectRisk', await p.evaluate(async () => {
  const r = await fetch('/api/exam/detectRisk', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceToken: window.XXQG_EXAM_ALIYUN_FP_UM_MODULE?.getToken() || '' }) });
  return (await r.text()).slice(0, 300);
}));
await b.close();