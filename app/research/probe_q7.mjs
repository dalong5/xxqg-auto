import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
const d = new DatabaseSync('data/app.db');
const jar = JSON.parse(d.prepare("select jar from logins where status='done' order by created_at desc limit 1").get().jar);
const cookies = Object.entries(jar).map(([name, value]) => ({ name, value, domain: '.xuexi.cn', path: '/' }));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 120)); });
await p.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.locator('.my-points-card', { hasText: '每日答题' }).first().locator('text=去答题').first().click();
await p.waitForTimeout(3500);
const cap = async () => (await p.locator('#JS_aliyun-captcha-dialog.show').count()) ? 'CAPTCHA' : '-';
for (let n = 1; n <= 6; n++) {
  const body = p.locator('.q-body').first();
  if (!(await body.count())) { console.log('no body'); break; }
  const type = (await p.locator('.q-header').first().innerText()).replace(/\s+/g, '');
  const before = (await body.innerText()).replace(/\s+/g, ' ').slice(0, 30);
  console.log('Q' + n, type, 'cap', await cap(), '|', before);
  await p.locator('.tips').first().click().catch(() => {});
  await p.waitForTimeout(700);
  const html = await p.locator('.ant-popover .line-feed').first().innerHTML().catch(() => '');
  await p.mouse.click(20, 20).catch(() => {});
  const tips = [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)].map(m => m[1].trim());
  const opts = p.locator('.q-answer.choosable');
  const c = await opts.count();
  console.log('  tips', tips.length, 'opts', c, 'cap', await cap());
  if (type.includes('填空')) {
    const inputs = p.locator('.q-body input');
    const ic = await inputs.count();
    for (let i = 0; i < ic; i++) if (tips[i]) await inputs.nth(i).fill(tips[i]).catch(() => {});
  } else if (tips.length) {
    for (const t of tips) for (let i = 0; i < c; i++) {
      const s = (await opts.nth(i).innerText()).trim().replace(/^[A-Z][.、]\s*/, '').replace(/\s+/g, '');
      if (s && t.replace(/\s+/g, '').includes(s)) await opts.nth(i).click().catch(() => {});
    }
  }
  await p.waitForTimeout(500);
  const btns = p.locator('.action-row > button');
  const labels = await btns.allInnerTexts().catch(() => []);
  const disabled = await btns.first().isDisabled().catch(() => 'n/a');
  console.log('  btns', JSON.stringify(labels), 'disabled', disabled, 'cap', await cap());
  if (labels.some(l => l.includes('交'))) {
    await btns.first().click().catch(e => console.log('  submit err', e.message.slice(0, 80)));
    await p.waitForTimeout(1500);
    const conf = p.locator('.ant-modal button:has-text("确")').first();
    if (await conf.count()) await conf.click().catch(() => {});
    console.log('  SUBMITTED');
    break;
  }
  if (disabled === true) { console.log('  disabled, skip'); break; }
  await btns.first().click().catch(e => console.log('  click err', e.message.slice(0, 100)));
  await p.waitForTimeout(3000);
  const after = (await body.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 30);
  console.log('  after', after === before ? 'SAME' : 'CHANGED', 'cap', await cap());
  if (after.length === 0) break;
}
console.log('final url', p.url());
await b.close();
