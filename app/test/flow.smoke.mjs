import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

// 隔离数据库和端口，测试不会操作真实账号。
const dataDir = mkdtempSync(path.join(tmpdir(), 'xxqg-flow-'));
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.HOST = '127.0.0.1';
const base = `http://127.0.0.1:${port}`;
const db = await import('../src/db.js');
const { newSession, clearCaptcha, closeBrowser } = await import('../src/xxqg/browser.js');
const procs = ['src/server.js', 'src/worker.js'].map(file => spawn(process.execPath, [file], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }));
let serviceLogs = '';
for (const child of procs) {
  child.stdout.on('data', data => { serviceLogs += data; });
  child.stderr.on('data', data => { serviceLogs += data; });
}
let browser;
let session;
try {
  const deadline = Date.now() + 30000;
  while (true) {
    try { if ((await (await fetch(`${base}/healthz`)).json()).workers) break; } catch {}
    if (Date.now() > deadline) throw new Error(`服务启动超时: ${serviceLogs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  let syncRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/sync')) syncRequests++; });
  await page.goto(base);
  await page.getByRole('button', { name: '生成登录二维码' }).click();
  await page.locator('#qrbox img').waitFor({ timeout: 45000 });
  assert.ok((await page.locator('#qrbox img').getAttribute('src')).startsWith('data:image/png'));
  console.log('PASS 官方二维码生成与渲染');
  await page.getByRole('button', { name: '浏览器自检' }).click();
  await page.getByText('任务已完成', { exact: false }).waitFor({ timeout: 60000 });
  console.log('PASS 官方登录页面浏览器自检');

  const me = await (await ctx.request.get(`${base}/api/me`)).json();
  db.upsertUser({ uid: 'smoke-user', visitorId: me.visitor, nick: '<img src=x onerror=alert(1)>', jar: {}, expiresAt: 0 });
  const renewal = await ctx.request.post(`${base}/api/login/start`);
  assert.equal(renewal.status(), 200, '账号满额时仍应允许重新扫码认证原账号');
  const jobId = db.enqueue({ kind: 'verification-test', uid: 'smoke-user', visitorId: me.visitor });
  db.beat('smoke-fixture');
  db.db.prepare("UPDATE jobs SET status='running',worker='smoke-fixture' WHERE id=?").run(jobId);
  session = await newSession(null, { jobId, uid: null });
  await session.page.setContent('<div id="JS_aliyun-captcha-dialog" class="show"><button style="position:absolute;left:100px;top:100px;width:200px;height:80px" onclick="this.parentElement.remove()">人工输入转发测试</button></div>');
  const pending = clearCaptcha(session.page).then(() => null, error => error);
  // 模拟误切到另一个排队日志，页面仍应自动找回账号的验证任务。
  const unrelated = db.enqueue({ kind: 'verification-log-test', visitorId: me.visitor });
  await page.evaluate(id => followJob(id), unrelated);
  await page.locator('#verificationImage').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#verificationImage').naturalWidth > 0);
  assert.equal(await page.locator('#acct img').count(), 0);
  const anonymous = await fetch(`${base}/api/jobs/${jobId}/verification`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'down', x: 100, y: 100 }) });
  assert.equal(anonymous.status, 404);
  const invalid = await ctx.request.post(`${base}/api/jobs/${jobId}/verification`, { data: { kind: 'down', x: -1, y: 100 } });
  assert.equal(invalid.status(), 400);
  const box = await page.locator('#verificationImage').boundingBox();
  const viewport = session.page.viewportSize();
  await page.locator('#verificationImage').click({ position: { x: 200 / viewport.width * box.width, y: 140 / viewport.height * box.height } });
  assert.equal(await pending, null);
  // 超过一批的历史事件也必须完整送达，不能先宣布结束。
  db.addEvent(jobId, null, 'step', { text: '▶ 开始 daily' });
  db.addEvent(jobId, null, 'log', { text: '[dbg] <div class="action-row">modal=0</div>' });
  db.addEvent(jobId, null, 'error', { error: 'locator.click: Timeout 6000ms exceeded\nCall log: private-browser-details' });
  for (let i = 0; i < 210; i++) db.addEvent(jobId, null, 'log', { text: `历史日志-${i}` });
  db.finishJob(jobId);
  await page.getByText('历史日志-209', { exact: false }).waitFor({ timeout: 15000 });
  const visibleLogs = await page.locator('#log').innerText();
  assert.match(visibleLogs, /开始 每日答题/);
  assert.match(visibleLogs, /正在检查答题页面状态/);
  assert.match(visibleLogs, /操作等待超时/);
  assert.doesNotMatch(visibleLogs, /daily|\[dbg\]|<div|locator\.|private-browser-details/);
  await page.locator('#verification').waitFor({ state: 'hidden', timeout: 10000 });
  await page.waitForTimeout(1200);
  assert.equal(syncRequests, 0, '任务结束不应自动循环查分');
  const other = await browser.newContext();
  const otherMe = await (await other.request.get(`${base}/api/me`)).json();
  db.upsertUser({ uid: 'smoke-user', visitorId: otherMe.visitor, nick: 'new owner', jar: {}, expiresAt: 0 });
  const oldOwner = await ctx.request.get(`${base}/api/jobs/${jobId}/events`);
  assert.equal(oldOwner.status(), 404, '重新授权后旧访客不能继续读取任务');
  await other.close();
  assert.deepEqual(errors, []);
  console.log('PASS 人工验证转发、访客隔离、坐标校验、任务恢复、昵称转义、历史日志与终止查分循环');
} finally {
  await session?.close();
  await browser?.close();
  await closeBrowser();
  for (const child of procs) child.kill();
  await Promise.all(procs.map(child => new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))));
  db.db.close();
  rmSync(dataDir, { recursive: true, force: true });
}
