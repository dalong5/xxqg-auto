import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-twenty-'));
process.env.WORKER_CONCURRENCY = '20';
process.env.MAX_ACCOUNTS = '20';
const db = await import('../src/db.js');
const entered = new Set();
let release;
const barrier = new Promise(resolve => { release = resolve; });
const scores = new Map();
const jobs = [];
for (let i = 0; i < 21; i++) {
  const uid = `account-${i}`;
  db.upsertUser({ uid, visitorId: `visitor-${i}`, nick: `测试${i}`, jar: { account: uid }, expiresAt: 0 });
  scores.set(uid, { total: 100 + i, today: i, tasks: { 1: { done: i, max: 30 } } });
  jobs.push(db.enqueue({ uid, visitorId: `visitor-${i}`, kind: 'run', tasks: ['article'] }));
}
mock.module('../src/loginflow.js', { exports: { claimLogin: () => null, driveLogin() {} } });
mock.module('../src/xxqg/client.js', { exports: {
  Jar: class { constructor(value) { this.account = value.account; } },
  score: async jar => scores.get(jar.account),
} });
mock.module('../src/xxqg/browser.js', { exports: { newSession() {}, closeBrowser() {}, getBrowser: async () => ({}) } });
mock.module('../src/xxqg/tasks.js', { exports: {
  learn: async (_kind, opts) => {
    assert.equal(opts.jar.account, opts.uid);
    assert.deepEqual(opts.progress(), { tasks: scores.get(opts.uid).tasks });
    entered.add(opts.uid);
    await barrier;
    if (opts.uid === 'account-0') throw new Error('需要人工验证');
    await opts.progress.refresh();
    return '隔离测试完成';
  },
  quiz() {},
} });
const worker = await import('../src/worker.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('twenty accounts run independently, overflow queues and one verification failure does not stop others', { timeout: 15000 }, async () => {
  await worker.startWorker();
  try {
    const started = Date.now() + 4000;
    while (entered.size < 20 && Date.now() < started) await pause(20);
    assert.equal(entered.size, 20);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM jobs WHERE status='running'").get().n, 20);
    assert.equal(db.getJob(jobs[20]).status, 'queued', 'the twenty-first account must wait for a free slot');
    assert.equal(db.enqueue({ uid: 'account-0', visitorId: 'visitor-0', kind: 'run', tasks: ['article'] }), jobs[0], 'the same account remains serial');
    release();
    const completed = Date.now() + 5000;
    while (jobs.some(id => ['queued', 'running'].includes(db.getJob(id).status)) && Date.now() < completed) await pause(20);
    assert.equal(db.getJob(jobs[0]).status, 'failed');
    assert.match(db.getJob(jobs[0]).error, /人工验证/);
    for (let i = 1; i < jobs.length; i++) {
      assert.equal(db.getJob(jobs[i]).status, 'done');
      assert.deepEqual(JSON.parse(db.getUser(`account-${i}`).last_score), scores.get(`account-${i}`));
    }
    assert.equal(entered.size, 21);
  } finally {
    worker.stopWorker(); release();
    const stopped = Date.now() + 2000;
    while (db.db.prepare("SELECT count(*) AS n FROM jobs WHERE status='running'").get().n && Date.now() < stopped) await pause(20);
  }
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
