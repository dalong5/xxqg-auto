// 仓储/调度/归一化的单元测试：锁住重构后的对外行为
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xxqg-store-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'test-secret-0123456789abcdef';
process.env.DOMAIN_DRIVER = 'mock';

let repo;
let scheduler;
let tasks;

before(async () => {
  repo = await import('../src/store/repo.js');
  scheduler = await import('../src/services/scheduler.js');
  tasks = await import('../src/domain/tasks.js');
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows 句柄 */
  }
});

test('visitors.list 用 LEFT JOIN 带出账号数（替代 N+1）', () => {
  const v = repo.visitors.create({ maxAccounts: 2 });
  repo.accounts.create({ visitorId: v.id, uid: 'u1', nick: 'n1', cookieEnc: 'enc' });
  repo.accounts.create({ visitorId: v.id, uid: 'u2', nick: 'n2', cookieEnc: 'enc' });
  const row = repo.visitors.list().find((x) => x.id === v.id);
  assert.equal(row.account_count, 2);
  assert.equal(repo.visitors.countAccounts(v.id), 2);
});

test('accounts.listWithSchedule 一条 SQL 带出定时', () => {
  const v = repo.visitors.create({});
  const a = repo.accounts.create({ visitorId: v.id, uid: 'u3', nick: 'n3', cookieEnc: 'enc' });
  const list1 = repo.accounts.listWithSchedule(v.id);
  assert.equal(list1.length, 1);
  assert.equal(list1[0].schedule, null);

  repo.schedules.upsert({ accountId: a.id, visitorId: v.id, at: '07:30', nextRunAt: 123 });
  const list2 = repo.accounts.listWithSchedule(v.id);
  assert.deepEqual(list2[0].schedule, { at: '07:30', nextRunAt: 123 });
});

test('listWithSchedule 不泄露 cookie_enc', () => {
  const v = repo.visitors.create({});
  repo.accounts.create({ visitorId: v.id, uid: 'u4', nick: 'n4', cookieEnc: 'SECRET' });
  const row = repo.accounts.listWithSchedule(v.id)[0];
  assert.equal(row.cookie_enc, undefined);
  assert.equal(row.cookieEnc, undefined);
  assert.equal(row.uid, 'u4');
});

test('jobs.countByStatus 走 SQL 聚合', () => {
  const before = repo.jobs.countByStatus();
  repo.jobs.enqueue({ type: 'run', visitorId: null, accountId: null, payload: { tasks: ['login'] } });
  const after = repo.jobs.countByStatus();
  assert.equal(after.queued, before.queued + 1);
  assert.equal(typeof after.done, 'number');
});

test('normalizeTasks：去重、过滤未知项、空值回退全套', () => {
  assert.deepEqual(tasks.normalizeTasks(['video', 'video', 'bogus']), ['video']);
  assert.deepEqual(tasks.normalizeTasks([]), tasks.TASK_KINDS);
  assert.deepEqual(tasks.normalizeTasks(null), tasks.TASK_KINDS);
});

test('nextRunAt 落在 HH:MM 之后 0~15 分钟', () => {
  const from = new Date();
  from.setHours(7, 0, 0, 0);
  const t = scheduler.nextRunAt('07:30', from.getTime());
  const deltaMin = (t - from.getTime()) / 60_000;
  assert.ok(deltaMin >= 30 && deltaMin <= 45, `delta=${deltaMin}`);
});

test('tickOnce 到点入队并推进 next_run_at', () => {
  const v = repo.visitors.create({});
  const a = repo.accounts.create({ visitorId: v.id, uid: 'u5', nick: 'n5', cookieEnc: 'enc' });
  const s = repo.schedules.upsert({ accountId: a.id, visitorId: v.id, at: '07:30', nextRunAt: 1 });
  const fired = scheduler.tickOnce(Date.now());
  // 前面的用例也留了到点的定时，这里只关心「至少触发了本账号这一条」
  assert.ok(fired >= 1, `fired=${fired}`);
  const after = repo.schedules.byAccount(a.id);
  assert.ok(after.next_run_at > Date.now(), 'next_run_at 应被推进到未来');
  const job = repo.jobs.activeForAccount(a.id);
  assert.ok(job, '应已入队');
  assert.equal(job.payload, JSON.stringify({ tasks: tasks.TASK_KINDS }));
  void s;
});
