import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-cross-visitor-'));
process.env.HOST = '127.0.0.1';
process.env.WORKER_CONCURRENCY = process.env.TEST_WORKER_CONCURRENCY || '2';
const db = await import('../src/db.js');
const entered = new Set();
let release;
const barrier = new Promise(resolve => { release = resolve; });
mock.module('../src/loginflow.js', { exports: { claimLogin: () => null, driveLogin() {} } });
mock.module('../src/xxqg/client.js', { exports: {
  Jar: class { constructor(value) { this.account = value.account; } },
  score: async () => ({ total: 0, today: 0, tasks: {} }),
} });
mock.module('../src/xxqg/browser.js', { exports: { newSession() {}, closeBrowser() {}, getBrowser: async () => ({}) } });
mock.module('../src/xxqg/tasks.js', { exports: {
  learn: async (_kind, opts) => {
    assert.equal(opts.jar.account, opts.uid, 'each task must use its own account credentials');
    entered.add(opts.uid);
    await barrier;
    return '隔离测试任务结束';
  },
  quiz() {},
} });
const worker = await import('../src/worker.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('two browser visitors start distinct accounts before either task finishes', { timeout: 40000 }, async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  let browser;
  try {
    const startup = Date.now() + 15000;
    while (true) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
      if (Date.now() > startup) throw new Error('测试接口启动超时');
      await pause(50);
    }
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
    const contexts = [await browser.newContext(), await browser.newContext()];
    const owners = [];
    const pages = [];
    for (const [index, context] of contexts.entries()) {
      const me = await (await context.request.get(`${base}/api/me`)).json();
      owners.push(me.visitor);
      const uid = `fixture-${index}`;
      db.upsertUser({ uid, visitorId: me.visitor, nick: `测试账号${index}`, jar: { account: uid }, expiresAt: 0 });
      const page = await context.newPage();
      await page.goto(base);
      await page.waitForFunction(uid => document.querySelector('#accountSelect').value === uid, uid);
      pages.push(page);
    }
    assert.notEqual(owners[0], owners[1]);
    await worker.startWorker();
    await pages[0].getByRole('button', { name: '只阅读', exact: true }).click();
    const firstDeadline = Date.now() + 4000;
    while (!entered.has('fixture-0') && Date.now() < firstDeadline) await pause(20);
    assert.ok(entered.has('fixture-0'), 'first task must already be running');
    await pages[1].getByRole('button', { name: '只阅读', exact: true }).click();
    const bothDeadline = Date.now() + 4000;
    while (entered.size < 2 && Date.now() < bothDeadline) await pause(20);
    assert.deepEqual([...entered].sort(), ['fixture-0', 'fixture-1'], 'the second visitor must not wait for the first task to finish');
    const running = db.db.prepare("SELECT * FROM jobs WHERE status='running' ORDER BY uid").all();
    assert.equal(running.length, 2);
    assert.deepEqual(running.map(job => job.visitor_id), owners);
    const duplicate = await contexts[0].request.post(`${base}/api/users/fixture-0/run`, { data: { tasks: ['article'] } });
    assert.equal((await duplicate.json()).jobId, running[0].id, 'one account remains serial');
    assert.equal((await contexts[1].request.post(`${base}/api/users/fixture-0/run`, { data: { tasks: ['article'] } })).status(), 404);
    assert.equal((await (await contexts[1].request.get(`${base}/api/users`)).json()).length, 1);
  } finally {
    worker.stopWorker(); release();
    const shutdown = Date.now() + 2000;
    while (db.db.prepare("SELECT count(*) AS n FROM jobs WHERE status='running'").get().n && Date.now() < shutdown) await pause(20);
    await browser?.close();
    const exited = new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    server.kill(); await exited;
  }
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
