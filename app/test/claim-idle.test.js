// 空闲时不应产生写事务：claimJob / claimLogin 空队列必须只读
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-claim-'));
const db = await import('../src/db.js');
const { claimLogin } = await import('../src/loginflow.js');

/** 记录这段时间内执行过的写语句（UPDATE/INSERT/DELETE） */
const withSqlSpy = (fn) => {
  const original = db.db.prepare.bind(db.db);
  const writes = [];
  db.db.prepare = (sql) => {
    if (/^\s*(update|insert|delete)\b/i.test(sql)) writes.push(sql.trim().split('\n')[0].slice(0, 60));
    return original(sql);
  };
  try {
    const result = fn();
    return { result, writes };
  } finally {
    db.db.prepare = original;
  }
};

test('队列为空时 claimJob 不产生任何写语句', () => {
  const { result, writes } = withSqlSpy(() => db.claimJob('run', 'w-test'));
  assert.equal(result, null);
  assert.deepEqual(writes, [], `空队列不该写库，实际执行了：${writes.join(' | ')}`);
});

test('队列为空时 claimLogin 不产生任何写语句', () => {
  const { result, writes } = withSqlSpy(() => claimLogin());
  assert.equal(result, null);
  assert.deepEqual(writes, [], `空队列不该写库，实际执行了：${writes.join(' | ')}`);
});

test('有排队任务时 claimJob 正常领取并改为 running', () => {
  db.touchVisitor('v-claim');
  db.upsertUser({ uid: 'u-claim', visitorId: 'v-claim', nick: 'x', jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
  const id = db.enqueue({ kind: 'run', uid: 'u-claim', visitorId: 'v-claim', tasks: ['daily'] });
  const claimed = db.claimJob('run', 'w-test');
  assert.equal(claimed.id, id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.worker, 'w-test');
  assert.equal(claimed.attempts, 1);
});

test('有扫码会话时 claimLogin 正常领取并改为 init', () => {
  const row = db.createLogin('v-claim');
  const claimed = claimLogin();
  assert.equal(claimed.sid, row.sid);
  assert.equal(claimed.status, 'init');
});

test('两个执行器不会领到同一个任务', () => {
  db.touchVisitor('v-claim2');
  db.upsertUser({ uid: 'u-claim2', visitorId: 'v-claim2', nick: 'x', jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
  db.enqueue({ kind: 'run', uid: 'u-claim2', visitorId: 'v-claim2', tasks: ['daily'] });
  const a = db.claimJob('run', 'w-a');
  const b = db.claimJob('run', 'w-b');
  assert.ok(a, '第一个执行器应领到任务');
  assert.equal(b, null, '第二个执行器不应重复领取');
});
