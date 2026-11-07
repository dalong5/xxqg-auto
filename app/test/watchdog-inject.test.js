// 故障注入：看门狗在真实状态机上是否按预期收尾
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-dog2-'));
const db = await import('../src/db.js');
const { watchdogTick } = await import('../src/worker.js');

const WORKER = 'w-inject';
const SILENCE = 600_000;

const seed = (uid, workerId, status, eventAgeMs) => {
  db.touchVisitor(`v-${uid}`);
  db.upsertUser({ uid, visitorId: `v-${uid}`, nick: uid, jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
  db.enqueue({ kind: 'run', uid, visitorId: `v-${uid}`, tasks: ['daily'] });
  const id = db.db.prepare("SELECT id FROM jobs WHERE uid = ? AND status = 'queued' ORDER BY rowid DESC LIMIT 1").get(uid).id;
  db.db.prepare("UPDATE jobs SET status = ?, worker = ?, started_at = ? WHERE id = ?").run(status, workerId, Date.now() - 700_000, id);
  db.addEvent(id, uid, 'log', { text: '进度' });
  db.db.prepare('UPDATE events SET created_at = ? WHERE job_id = ?').run(Date.now() - eventAgeMs, id);
  return id;
};

const statusOf = (id) => db.db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(id);

test('沉默超阈值的任务会被判失败、写 error 事件、并关闭浏览器', async () => {
  const id = seed('dog-a', WORKER, 'running', 11 * 60_000);
  let closed = 0;
  const handled = await watchdogTick({ workerId: WORKER, silenceMs: SILENCE, close: async () => { closed++; } });
  assert.equal(handled, 1, '应处理 1 个卡住的任务');
  assert.equal(statusOf(id).status, 'failed');
  assert.match(statusOf(id).error, /无进展/);
  assert.equal(closed, 1, '应关闭浏览器让挂起的调用抛错');
  const ev = db.eventsAfter(id).filter((e) => e.type === 'error');
  assert.ok(ev.length >= 1, '应写入 error 事件给用户看');
  assert.match(JSON.parse(ev.at(-1).payload).error, /无进展/);
});

test('刚有进展的任务不会被误杀，也不会白关浏览器', async () => {
  const id = seed('dog-b', WORKER, 'running', 30_000);
  let closed = 0;
  const handled = await watchdogTick({ workerId: WORKER, silenceMs: SILENCE, close: async () => { closed++; } });
  assert.equal(handled, 0);
  assert.equal(statusOf(id).status, 'running', '不该动它');
  assert.equal(closed, 0, '没事不该关浏览器（避免把正常任务打断）');
});

test('别的执行器名下的任务不会被这个 worker 收掉', async () => {
  const id = seed('dog-c', 'w-other', 'running', 30 * 60_000);
  let closed = 0;
  const handled = await watchdogTick({ workerId: WORKER, silenceMs: SILENCE, close: async () => { closed++; } });
  assert.equal(handled, 0, '不能动别人的任务');
  assert.equal(statusOf(id).status, 'running');
  assert.equal(closed, 0);
});

test('pausing 状态的卡住任务也会被收尾（不会永远卡在暂停中）', async () => {
  const id = seed('dog-d', WORKER, 'pausing', 20 * 60_000);
  let closed = 0;
  const handled = await watchdogTick({ workerId: WORKER, silenceMs: SILENCE, close: async () => { closed++; } });
  assert.equal(handled, 1);
  assert.notEqual(statusOf(id).status, 'pausing', '不能停留在 pausing');
});

test('关闭浏览器抛错也不会让看门狗中断', async () => {
  const id = seed('dog-e', WORKER, 'running', 15 * 60_000);
  const handled = await watchdogTick({
    workerId: WORKER,
    silenceMs: SILENCE,
    close: async () => { throw new Error('close failed'); },
  });
  assert.equal(handled, 1);
  assert.equal(statusOf(id).status, 'failed', '即使关浏览器失败，任务也要落失败');
});
