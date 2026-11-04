import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-worker-'));
process.env.WORKER_CONCURRENCY = '1';
let refreshed = false;
let nextJob = null;
let result;
let scoreCalls = 0;
let finalScoreFailure = false;
const events = [];
const workerIds = new Set();
const { seal } = await import('../src/crypto.js');
mock.module('../src/db.js', { exports: {
  getUser: () => ({ sealed_cookie: seal({ token: 'test' }) }),
  setUserScore() {}, addEvent: (...e) => events.push(e), beat: id => workerIds.add(id), requeueDeadJobs() {}, trimEvents() {}, deleteStaleLogins() {},
  claimJob: () => { const j = nextJob; nextJob = null; return j; },
  finishJob: () => { result = 'done'; }, failJob: () => { result = 'failed'; },
} });
mock.module('../src/loginflow.js', { exports: { claimLogin: () => null, driveLogin() {} } });
mock.module('../src/xxqg/client.js', { exports: { Jar: class {}, score: async () => {
  if (finalScoreFailure && ++scoreCalls > 1) throw new Error('积分服务不可用');
  return { total: 1, today: 1, tasks: {} };
} } });
mock.module('../src/xxqg/browser.js', { exports: { newSession() {}, closeBrowser() {}, getBrowser: async () => ({}) } });
mock.module('../src/xxqg/tasks.js', { exports: {
  learn: async (_kind, opts) => { assert.equal(typeof opts.progress.refresh, 'function'); await opts.progress.refresh(); refreshed = true; throw new Error('积分未达标'); },
  quiz: async () => { throw new Error('需要人工验证'); },
} });
const worker = await import('../src/worker.js');
test('worker wires per-item refresh and reports task failure', async () => {
  nextJob = { id: 'test', uid: '1', kind: 'run', tasks: '["article"]', attempts: 1, created_at: Date.now() };
  await worker.startWorker();
  try {
    assert.match([...workerIds][0], /^w-\d+-[a-f0-9-]{36}$/, 'worker identity must not be reused when a container restarts as PID 1');
    const deadline = Date.now() + 2000;
    while (!result && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(refreshed, true);
    assert.equal(result, 'failed');
    result = null;
    scoreCalls = 0;
    finalScoreFailure = true;
    nextJob = { id: 'final-check', uid: '1', kind: 'run', tasks: '[]', attempts: 1, created_at: Date.now() };
    const end = Date.now() + 2000;
    while (!result && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    assert.equal(result, 'failed', 'final score failure must not mark the job done');
  } finally { worker.stopWorker(); }
});
test.after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
