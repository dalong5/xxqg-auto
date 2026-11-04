import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-multi-'));
process.env.MAX_ACCOUNTS = '2';
process.env.HOST = '127.0.0.1';
const db = await import('../src/db.js');

test('multiple accounts keep selection, scores, jobs and verification isolated', { timeout: 45000 }, async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
      if (i > 100) throw new Error('API startup timeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
    const context = await browser.newContext();
    const visitor = (await (await context.request.get(`${base}/api/me`)).json()).visitor;
    for (const [uid, nick, total] of [['101', '账号甲', 101], ['202', '账号乙', 202]]) {
      db.upsertUser({ uid, visitorId: visitor, nick, jar: { token: uid }, expiresAt: 0 });
      db.setUserScore(uid, { today: total, total, tasks: { 6: { done: uid === '101' ? 1 : 2, max: 5 } } });
    }
    assert.throws(() => db.upsertUser({ uid: 'c', visitorId: visitor, nick: 'extra', jar: {}, expiresAt: 0 }), /最多绑定 2/);
    const a = db.enqueue({ kind: 'run', uid: '101', visitorId: visitor, tasks: ['daily'] });
    const b = db.enqueue({ kind: 'run', uid: '202', visitorId: visitor, tasks: ['daily'] });
    assert.notEqual(a, b);
    assert.equal(db.enqueue({ kind: 'run', uid: '101', visitorId: visitor }), a);
    assert.ok(db.claimJob('run', 'fixture'));
    assert.ok(db.claimJob('run', 'fixture'), 'different accounts can be running together');
    const page = await context.newPage();
    await page.addInitScript(() => { if (!sessionStorage.getItem('selectedUser')) sessionStorage.setItem('selectedUser', '101'); });
    await page.goto(base);
    await page.locator('#accountSelect').waitFor();
    await page.waitForFunction(() => document.querySelector('#accountSelect').value === '101');
    assert.match(await page.locator('#acct').innerText(), /101/);
    await page.locator('#accountSelect').selectOption('202');
    await page.waitForFunction(() => user?.uid === '202' && followedJob === user.active_job);
    db.addEvent(a, '101', 'score', { today: 999, total: 999, tasks: {} });
    db.addEvent(b, '202', 'log', { text: '乙的独立日志' });
    await page.getByText('乙的独立日志', { exact: false }).waitFor();
    assert.match(await page.locator('#acct').innerText(), /202/);
    assert.doesNotMatch(await page.locator('#acct').innerText(), /999/);
    await page.evaluate(() => load());
    assert.equal(await page.locator('#accountSelect').inputValue(), '202');
    db.addEvent(b, '202', 'verification', { width: 100, height: 100, image: 'AA==' });
    await page.locator('#verification').waitFor({ state: 'visible' });
    await page.locator('#accountSelect').selectOption('101');
    await page.locator('#verification').waitFor({ state: 'hidden' });
    assert.doesNotMatch(await page.locator('#log').innerText(), /乙的独立日志/);
    await page.reload();
    await page.waitForFunction(() => user?.uid === '101');
    db.finishJob(a);
    db.finishJob(b);
    await page.waitForFunction(() => followedJob === null);
    await page.locator('#accountSelect').selectOption('202');
    await page.reload();
    await page.waitForFunction(() => user?.uid === '202');
    await page.getByRole('button', { name: '只阅读', exact: true }).click();
    await page.waitForFunction(() => followedJob !== null);
    assert.equal(db.getJob(await page.evaluate(() => followedJob)).uid, '202');
    const other = await browser.newContext();
    assert.deepEqual(await (await other.request.get(`${base}/api/users`)).json(), []);
    assert.equal((await other.request.post(`${base}/api/users/202/run`, { data: { tasks: ['article'] } })).status(), 404);
    assert.equal((await other.request.get(`${base}/api/jobs/${b}/events`)).status(), 404);
    await other.close();
    let releaseOld;
    let oldStarted;
    const held = new Promise(resolve => { releaseOld = resolve; });
    const started = new Promise(resolve => { oldStarted = resolve; });
    const snapshot = await (await context.request.get(`${base}/api/users`)).json();
    let requests = 0;
    await page.route('**/api/users', async route => {
      if (++requests === 1) {
        oldStarted();
        await held;
        await route.fulfill({ json: snapshot.filter(account => account.uid === '101') });
      } else await route.fulfill({ json: snapshot });
    });
    await page.evaluate(() => { window.delayedLoad = load(); });
    await started;
    await page.evaluate(() => load());
    releaseOld();
    await page.evaluate(() => window.delayedLoad);
    assert.equal(await page.locator('#accountSelect').inputValue(), '202', 'late responses must not replace newer account state');
    await page.unroute('**/api/users');
    const rejected = await context.request.delete(`${base}/api/users/202`);
    assert.equal(rejected.status(), 409, 'running or queued tasks must prevent unbinding');
    assert.ok(db.getUser('202'));
    await page.route('**/api/login/start', route => route.fulfill({ json: { sid: 'login-fixture' } }));
    await page.route('**/api/login/login-fixture/events', route => route.fulfill({
      contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'done', payload: { uid: 202, nick: '账号乙' } })}\n\n`,
    }));
    await page.locator('#accountSelect').selectOption('101');
    await page.getByRole('button', { name: '生成登录二维码', exact: true }).click();
    await page.waitForFunction(() => user?.uid === '202');
    assert.equal(await page.locator('#accountSelect').inputValue(), '202', 'numeric login UID selects the authenticated account');
  } finally {
    await browser?.close();
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  }
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
