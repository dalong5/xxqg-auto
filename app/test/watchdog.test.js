// 看门狗：只终结「本执行器名下、长时间没有任何事件」的任务
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-dog-'));
const db = await import('../src/db.js');

const visitor = 'v-dog';
const uid = 'dog-1';
const worker = 'w-dog';

const makeRunning = (jobId, workerId = worker) => {
  db.enqueue({ kind: 'run', uid, visitorId: visitor, tasks: ['daily'] });
  const row = db.db.prepare("SELECT id FROM jobs WHERE uid = ? AND status = 'queued' ORDER BY rowid DESC LIMIT 1").get(uid);
  db.db.prepare("UPDATE jobs SET status='running', worker=?, started_at=? WHERE id=?").run(workerId, Date.now(), row.id);
  return row.id;
};

const setLastEvent = (jobId, at) => {
  db.db.prepare('DELETE FROM events WHERE job_id = ?').run(jobId);
  db.addEvent(jobId, uid, 'log', { text: 'x' });
  db.db.prepare('UPDATE events SET created_at = ? WHERE job_id = ?').run(at, jobId);
};

test('沉默超过阈值、且属于本执行器的任务会被判定卡住', () => {
  db.upsertUser({ uid, visitorId: visitor, nick: 't', jar: JSON.stringify({ token: 'k' }), expiresAt: 0 });
  const jobId = makeRunning(jobXid());
  setLastEvent(jobId, Date.now() - 11 * 60_000);
  const stuck = db.stuckJobs(worker, 10 * 60_000);
  assert.ok(stuck.some((j) => j.id === jobId), '应识别出卡住的任务');
});

test('刚有事件的任务不会被误杀', () => {
  const jobId = makeRunning(jobXid());
  setLastEvent(jobId, Date.now() - 30_000);
  const stuck = db.stuckJobs(worker, 10 * 60_000);
  assert.ok(!stuck.some((j) => j.id === jobId), '30 秒前还有事件，不该判卡住');
});

test('别的执行器名下的任务不会被这个 worker 终结', () => {
  const jobId = makeRunning(jobXid(), 'w-other');
  setLastEvent(jobId, Date.now() - 30 * 60_000);
  const stuck = db.stuckJobs(worker, 10 * 60_000);
  assert.ok(!stuck.some((j) => j.id === jobId), '不能动别人的任务');
});

let seq = 0;
function jobXid() {
  return `dogjob-${++seq}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * makeRunning 依赖 uid 唯一的活动任务约束，所以每轮把上一个任务收尾，
 * 否则 enqueue 会复用同一个 job（返回已有 id）。
 */
test.beforeEach(() => {
  db.db.prepare("UPDATE jobs SET status='done', finished_at=? WHERE status IN ('running','queued')").run(Date.now());
});
