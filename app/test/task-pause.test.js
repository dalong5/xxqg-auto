import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-pause-'));
process.env.WORKER_CONCURRENCY = '2';
process.env.MAX_ACCOUNTS = '2';
const db = await import('../src/db.js');
const cycles = new Map();
const closed = new Set();
const release = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await sleep(20);
  assert.ok(check(), 'expected state did not arrive');
}
mock.module('../src/loginflow.js', { exports: { claimLogin: () => null, driveLogin() {} } });
mock.module('../src/xxqg/client.js', { exports: {
  Jar: class {}, qrContent() {}, score: async () => ({ total: 7, today: 7, tasks: {} }),
} });
mock.module('../src/xxqg/browser.js', { exports: { newSession() {}, closeBrowser() {}, getBrowser: async () => ({}) } });
mock.module('../src/xxqg/tasks.js', { exports: {
  learn: async (_kind, opts) => {
    const cycle = (cycles.get(opts.uid) || 0) + 1;
    cycles.set(opts.uid, cycle);
    try {
      if (opts.uid === 'a' && cycle === 3) {
        while (db.getJob(opts.jobId).status !== 'pausing') await sleep(20);
        throw new Error('HTTP 429 timeout');
      }
      while (!release.has(opts.uid)) { opts.shouldStop(); await sleep(20); }
      return '测试完成';
    } finally { await sleep(100); closed.add(`${opts.uid}-${cycle}`); }
  }, quiz() {},
} });
const worker = await import('../src/worker.js');
const { default: app } = await import('../src/app.js');

test('paused tasks resume through existing task actions without crossing accounts or overlapping execution', { timeout: 45000 }, async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
    const context = await browser.newContext();
    const owner = (await (await context.request.get(`${base}/api/me`)).json()).visitor;
    const jobs = {};
    for (const uid of ['a', 'b']) {
      db.upsertUser({ uid, visitorId: owner, nick: uid, jar: {}, expiresAt: 0 });
      jobs[uid] = db.enqueue({ kind: 'run', uid, visitorId: owner, tasks: ['article'] });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => sessionStorage.setItem('selectedUser', 'a'));
    await page.goto(base);
    assert.equal((await context.request.post(`${base}/api/jobs/${jobs.a}/pause`)).status(), 200);
    await until(() => db.getJob(jobs.a).status === 'paused');
    assert.equal(db.getJob(jobs.a).attempts, 0);
    assert.equal(db.enqueue({ kind: 'run', uid: 'a', visitorId: owner }), jobs.a);
    assert.equal(db.deleteUser('a', owner).changes, 0);
    const outsider = await browser.newContext();
    for (const action of ['pause', 'resume']) assert.equal((await outsider.request.post(`${base}/api/jobs/${jobs.a}/${action}`)).status(), 404);
    await outsider.close();
    await page.reload();
    assert.equal(await page.locator('#btnPause, #btnResume').count(), 0, 'dedicated pause/resume buttons are removed');
    await page.getByRole('button', { name: '只阅读', exact: true }).click();
    await until(() => db.getJob(jobs.a).status === 'queued');
    await worker.startWorker();
    await until(() => cycles.size === 2);
    assert.equal((await context.request.post(`${base}/api/jobs/${jobs.a}/pause`)).status(), 200);
    await until(() => db.getJob(jobs.a).status === 'pausing');
    assert.equal((await context.request.post(`${base}/api/jobs/${jobs.a}/resume`)).status(), 409);
    await until(() => db.getJob(jobs.a).status === 'paused');
    assert.ok(closed.has('a-1'), 'the browser context must close before pause is acknowledged');
    assert.equal(db.getJob(jobs.b).status, 'running');
    await page.getByRole('button', { name: '只阅读', exact: true }).click();
    await until(() => cycles.get('a') === 2);
    assert.equal(db.getJob(jobs.a).status, 'running');
    release.add('a'); release.add('b');
    await until(() => Object.values(jobs).every(id => db.getJob(id).status === 'done'));
    assert.equal((await context.request.post(`${base}/api/jobs/${jobs.a}/pause`)).status(), 409);
    assert.equal((await context.request.post(`${base}/api/jobs/${jobs.a}/resume`)).status(), 409);
    assert.equal(JSON.parse(db.getUser('a').last_score).today, 7);
    const riskJob = db.enqueue({ kind: 'run', uid: 'a', visitorId: owner, tasks: ['article'] });
    await until(() => cycles.get('a') === 3);
    await context.request.post(`${base}/api/jobs/${riskJob}/pause`);
    await until(() => db.getJob(riskJob).status === 'failed');
    assert.equal(db.getJob(riskJob).attempts, 1, 'pause cannot turn a platform refusal into a retry');
    assert.equal((await context.request.post(`${base}/api/jobs/${riskJob}/resume`)).status(), 409);
  } finally {
    worker.stopWorker(); release.add('a'); release.add('b');
    await until(() => !db.db.prepare("SELECT 1 FROM jobs WHERE status IN ('running','pausing')").get());
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
});

test('pause and resume controls are absent on narrow and desktop homepages', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
    for (const width of [375, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 667 } });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => document.querySelector('#accountHint').textContent.includes('已绑定'));
      assert.equal(await page.locator('#btnPause, #btnResume').count(), 0);
      assert.equal(await page.getByRole('button', { name: '暂停任务', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '继续任务', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '查当前积分', exact: true }).isVisible(), true);
      assert.match(await page.locator('#taskStatus').innerText(), /扫码登录/);
      await context.close();
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});

test('a paused job cannot lock an account after it is rebound to another visitor', () => {
  const user = db.upsertUser({ uid: 'transfer', visitorId: 'old-owner', nick: '测试', jar: {}, expiresAt: 0 });
  const id = db.enqueue({ kind: 'run', uid: user.uid, visitorId: 'old-owner', tasks: ['daily'] });
  db.requestJobPause(id, 'old-owner');
  db.upsertUser({ uid: user.uid, visitorId: 'new-owner', nick: '测试', jar: {}, expiresAt: 0 });
  assert.equal(db.getJob(id).status, 'failed');
  assert.equal(db.resumeJob(id, 'old-owner'), undefined);
  assert.equal(db.resumeJob(id, 'new-owner'), undefined);
  const rebound = db.enqueue({ kind: 'run', uid: user.uid, visitorId: 'new-owner' });
  assert.notEqual(rebound, id);
  db.failJob(rebound, '隔离测试结束');
});

test('pause wins a completion race and survives worker loss without automatic resumption', () => {
  const id = db.enqueue({ kind: 'run', uid: 'a', visitorId: db.getUser('a').visitor_id, tasks: ['daily'] });
  db.claimJob('run', 'dead-pause-worker');
  const owner = db.getUser('a').visitor_id;
  assert.equal(db.requestJobPause(id, owner).status, 'pausing');
  assert.equal(db.finishJob(id).status, 'paused');
  assert.equal(db.resumeJob(id, owner).status, 'queued');
  db.claimJob('run', 'dead-pause-worker');
  db.requestJobPause(id, owner);
  db.requeueDeadJobs();
  assert.equal(db.getJob(id).status, 'paused');
  assert.equal(db.claimJob('run', 'other-worker'), null);
});

test('rebinding during pause cleanup cannot leave an inaccessible paused job', () => {
  const uid = 'cleanup-transfer';
  db.upsertUser({ uid, visitorId: 'before', nick: '测试', jar: {}, expiresAt: 0 });
  const id = db.enqueue({ kind: 'run', uid, visitorId: 'before', tasks: ['daily'] });
  db.claimJob('run', 'cleanup-worker');
  db.requestJobPause(id, 'before');
  db.upsertUser({ uid, visitorId: 'after', nick: '测试', jar: {}, expiresAt: 0 });
  assert.equal(db.finishPausedJob(id).status, 'failed');
  const replacement = db.enqueue({ kind: 'run', uid, visitorId: 'after' });
  assert.notEqual(replacement, id);
  db.db.prepare("UPDATE jobs SET status = 'pausing', worker = 'lost-cleanup' WHERE id = ?").run(replacement);
  db.upsertUser({ uid, visitorId: 'latest', nick: '测试', jar: {}, expiresAt: 0 });
  db.requeueDeadJobs();
  assert.equal(db.getJob(replacement).status, 'failed');
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
