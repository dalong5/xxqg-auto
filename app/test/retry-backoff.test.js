// 失败退避必须真的生效：failJob(retry=true) 把 created_at 推到未来，
// claimJob 没有时间条件的话会立刻把任务重新领走，等于没有退避。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-backoff-'));
const db = await import('../src/db.js');

const setup = (uid) => {
  db.touchVisitor(`v-${uid}`);
  db.upsertUser({ uid, visitorId: `v-${uid}`, nick: uid, jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
  return db.enqueue({ kind: 'run', uid, visitorId: `v-${uid}`, tasks: ['daily'] });
};

test('失败重试的任务会进入退避期，期间领不到', () => {
  const id = setup('bk-1');
  const claimed = db.claimJob('run', 'w1');
  assert.equal(claimed.id, id);
  db.failJob(id, 'ECONNRESET', true, 30_000);

  const row = db.getJob(id);
  assert.equal(row.status, 'queued');
  assert.ok(row.created_at > Date.now(), 'created_at 应被推到未来（退避）');

  assert.equal(db.claimJob('run', 'w2'), null, '退避期内不该被领走');
});

test('退避时间到了就能正常领取', () => {
  const id = setup('bk-2');
  db.claimJob('run', 'w1');
  db.failJob(id, 'ECONNRESET', true, 30_000);
  // 把退避到期时间拨到过去，模拟 30 秒后
  db.db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  const again = db.claimJob('run', 'w2');
  assert.equal(again?.id, id, '退避结束后应能重新领取');
  assert.equal(again.attempts, 2, '重试次数应累加');
});

test('不重试的失败直接终结，不会回到队列', () => {
  const id = setup('bk-3');
  db.claimJob('run', 'w1');
  db.failJob(id, '需要人工验证', false);
  assert.equal(db.getJob(id).status, 'failed');
  assert.equal(db.claimJob('run', 'w2'), null);
});

test('新入队的任务立刻可领（不要把正常任务也挡住）', () => {
  const id = setup('bk-4');
  const claimed = db.claimJob('run', 'w1');
  assert.equal(claimed?.id, id);
});
