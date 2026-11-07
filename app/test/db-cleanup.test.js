// 验证码截图清理、失败退避、登录失效标记的存储层测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-cleanup-'));
const db = await import('../src/db.js');

const uid = '9001.0';
const visitor = 'v-cleanup';

const makeJob = (id, status = 'done') => {
  db.enqueue({ kind: 'run', uid, visitorId: visitor, tasks: ['daily'] });
  const row = db.db.prepare("SELECT id FROM jobs WHERE uid = ? AND status = 'queued' ORDER BY rowid DESC LIMIT 1").get(uid);
  db.db.prepare('UPDATE jobs SET id = ?, status = ? WHERE id = ?').run(id, status, row.id);
};

test('验证码帧只保留最近 N 条，自动通过后全部删除', () => {
  const jobId = 'job-frames';
  makeJob(jobId);
  for (let i = 0; i < 6; i++) {
    db.addEvent(jobId, uid, 'verification', { image: 'x'.repeat(1000), n: i });
  }
  db.trimVerificationFrames(jobId, 2);
  const left = db.db.prepare("SELECT COUNT(*) n FROM events WHERE job_id = ? AND type = 'verification'").get(jobId).n;
  assert.equal(left, 2, `应只剩 2 帧，实际 ${left}`);

  db.clearVerificationFrames(jobId);
  const after = db.db.prepare("SELECT COUNT(*) n FROM events WHERE job_id = ? AND type = 'verification'").get(jobId).n;
  assert.equal(after, 0, '自动通过后应清空截图帧');
});

test('可重试失败会退避：重新排队但 created_at 被推到未来', () => {
  const jobId = 'job-retry';
  makeJob(jobId, 'running');
  const before = Date.now();
  db.failJob(jobId, 'ECONNRESET', true, 30_000);
  const row = db.getJob(jobId);
  assert.equal(row.status, 'queued');
  assert.ok(Number(row.created_at) >= before + 29_000, `created_at 应推迟，实际 ${row.created_at - before}ms`);
});

test('不可重试失败直接 failed 并记录原因', () => {
  const jobId = 'job-fail';
  makeJob(jobId, 'running');
  db.failJob(jobId, '平台要求安全验证', false);
  const row = db.getJob(jobId);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /安全验证/);
});

test('登录失效标记可置位、重新扫码后清零，且随账号列表返回', () => {
  db.upsertUser({ uid, visitorId: visitor, nick: 't', jar: JSON.stringify({ token: 'k' }), expiresAt: 0 });
  db.markNeedsRescan(uid);
  assert.equal(db.getUser(uid).needs_rescan, 1);

  const listed = db.listUsers(visitor).find((u) => u.uid === uid);
  assert.ok(listed, '账号应出现在列表里');
  assert.equal(Number(listed.needs_rescan), 1, '列表要带失效标记，前端才能提示');

  // 重新扫码（upsert）应清零
  db.upsertUser({ uid, visitorId: visitor, nick: 't', jar: JSON.stringify({ token: 'k2' }), expiresAt: 0 });
  assert.equal(db.getUser(uid).needs_rescan, 0);
});
