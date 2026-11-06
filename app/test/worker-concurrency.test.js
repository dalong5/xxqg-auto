import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-concurrent-'));
process.env.WORKER_CONCURRENCY = '2';
const { seal } = await import('../src/crypto.js');
const queue = ['a', 'b'].map(uid => ({ id: uid, uid, kind: 'run', tasks: '["article"]', started_at: Date.now() }));
const entered = new Set();
const finished = new Set();
let release;
const barrier = new Promise(resolve => { release = resolve; });
mock.module('../src/db.js', { exports: {
  getJob: () => ({ status: 'running' }), finishPausedJob() {},
  getUser: uid => ({ sealed_cookie: seal({ account: uid }) }),
  scheduledJobError: () => null,
  setUserScore() {}, addEvent() {}, beat() {}, requeueDeadJobs() {}, trimEvents() {}, deleteStaleLogins() {},
  claimJob: kind => kind === 'run' ? queue.shift() || null : null,
  finishJob: id => finished.add(id), failJob: id => finished.add(id),
} });
mock.module('../src/loginflow.js', { exports: { claimLogin: () => null, driveLogin() {} } });
mock.module('../src/xxqg/client.js', { exports: {
  Jar: class { constructor(value) { this.account = value.account; } },
  score: async () => ({ total: 0, today: 0, tasks: {} }),
} });
mock.module('../src/xxqg/browser.js', { exports: { newSession() {}, closeBrowser() {}, getBrowser: async () => ({}) } });
mock.module('../src/xxqg/tasks.js', { exports: {
  learn: async (_kind, opts) => {
    assert.equal(opts.jar.account, opts.uid);
    entered.add(opts.uid);
    await barrier;
    return 'fixture';
  },
  quiz() {},
} });
const worker = await import('../src/worker.js');

test('two accounts execute concurrently with their own credentials', async () => {
  await worker.startWorker();
  try {
    const deadline = Date.now() + 3000;
    while (entered.size < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual([...entered].sort(), ['a', 'b']);
    assert.equal(finished.size, 0, 'both must start before either finishes');
    release();
    while (finished.size < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(finished.size, 2);
  } finally { release(); worker.stopWorker(); }
});

test.after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
