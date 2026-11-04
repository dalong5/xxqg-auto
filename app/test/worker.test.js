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
let riskFailure = '';
let retried;
let platformCalls = 0;
let scoreFailureAt = Infinity;
const pauses = [];
const events = [];
const workerIds = new Set();
const { seal } = await import('../src/crypto.js');
mock.module('../src/db.js', { exports: {
  getUser: () => ({ sealed_cookie: seal({ token: 'test' }) }),
  enqueueScheduledJobs() {}, scheduledJobError: job => job.id === 'stale' ? '往日定时任务已跳过' : null, pauseScheduleForJob: (...args) => pauses.push(args),
  setUserScore() {}, addEvent: (...e) => events.push(e), beat: id => workerIds.add(id), requeueDeadJobs() {}, trimEvents() {}, deleteStaleLogins() {},
  claimJob: () => { const j = nextJob; nextJob = null; return j; },
  finishJob: () => { result = 'done'; }, failJob: (_id, _error, retry) => { result = 'failed'; retried = retry; },
} });
mock.module('../src/loginflow.js', { exports: { claimLogin: () => null, driveLogin() {} } });
mock.module('../src/xxqg/client.js', { exports: { Jar: class {}, score: async () => {
  platformCalls++;
  if (platformCalls === scoreFailureAt) throw new Error('HTTP 429 from score refresh');
  if (finalScoreFailure && ++scoreCalls > 1) throw new Error('积分服务不可用');
  return { total: 1, today: 1, tasks: {} };
} } });
mock.module('../src/xxqg/browser.js', { exports: { newSession() {}, closeBrowser() {}, getBrowser: async () => ({}) } });
mock.module('../src/xxqg/tasks.js', { exports: {
  learn: async (_kind, opts) => { assert.equal(typeof opts.progress.refresh, 'function'); await opts.progress.refresh(); refreshed = true; throw new Error(riskFailure || '积分未达标'); },
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
    finalScoreFailure = false;
    for (const message of ['平台请求失败 HTTP 429 timeout', 'HTTP 403 timeout', 'captcha timeout', 'risk control timeout']) {
      result = null;
      riskFailure = message;
      nextJob = { id: 'risk-check', uid: '1', kind: 'run', tasks: '["article"]', attempts: 1, created_at: Date.now() };
      const riskDeadline = Date.now() + 2000;
      while (!result && Date.now() < riskDeadline) await new Promise(r => setTimeout(r, 20));
      assert.equal(result, 'failed');
      assert.equal(retried, false, 'platform risk responses must not be retried as network timeouts');
      assert.equal(pauses.at(-1)[0].uid, '1');
      assert.equal(pauses.at(-1)[2], true, 'manual risk failures also stop subsequent automatic jobs');
    }
    result = null;
    scoreFailureAt = platformCalls + 2;
    nextJob = { id: 'score-risk', uid: '1', kind: 'run', tasks: '["article"]', attempts: 1, created_at: Date.now() };
    const scoreRiskDeadline = Date.now() + 2000;
    while (!result && Date.now() < scoreRiskDeadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(result, 'failed');
    assert.equal(pauses.at(-1)[2], true, 'score refresh must preserve the risk response before pausing automation');
    result = null;
    const previousCalls = platformCalls;
    nextJob = { id: 'stale', uid: '1', kind: 'run', tasks: '["article"]', attempts: 1, created_at: Date.now() };
    const staleDeadline = Date.now() + 2000;
    while (!result && Date.now() < staleDeadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(result, 'failed');
    assert.equal(platformCalls, previousCalls, 'expired scheduled work must not contact the platform');
    assert.ok(events.some(event => event[3]?.text === '▶ 开始 阅读文章'));
    assert.ok(events.some(event => event[3]?.error?.includes('频繁')));
  } finally { worker.stopWorker(); }
});
test.after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
