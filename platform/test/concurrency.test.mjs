// 并发回归：这些用例在修复前是红的（重复作业 / 500 / 幽灵任务）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xxqg-conc-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'test-secret-0123456789abcdef';
process.env.DOMAIN_DRIVER = 'mock';

let repo;
let svc;
let jobsSvc;
let seal;
let getDb;

before(async () => {
  repo = await import('../src/store/repo.js');
  svc = await import('../src/services/accounts.js');
  jobsSvc = await import('../src/services/jobs.js');
  ({ seal } = await import('../src/crypto.js'));
  ({ getDb } = await import('../src/store/db.js'));
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows */
  }
});

function makeAccount(uid = 'c1') {
  const v = repo.visitors.create({ maxAccounts: 5 });
  const a = repo.accounts.create({ visitorId: v.id, uid, nick: uid, cookieEnc: seal({ mock: true, uid }) });
  return { visitor: v, account: a };
}

test('同一账号并发入队 5 次 → 只产生 1 条作业（DB 唯一索引兜底）', () => {
  const { visitor, account } = makeAccount('c1');
  const ids = new Set();
  for (let i = 0; i < 5; i++) ids.add(jobsSvc.enqueueRun(account, { tasks: ['login'] }).jobId);
  assert.equal(ids.size, 1, `应当只有一个 jobId，实际 ${[...ids].join(',')}`);
  const active = repo.jobs.recent({ accountId: account.id, limit: 10 }).filter((j) => j.type === 'run' && ['queued', 'running'].includes(j.status));
  assert.equal(active.length, 1);
  void visitor;
});

test('sync 作业不受 run 的唯一约束影响（可并存）', () => {
  const { account } = makeAccount('c2');
  jobsSvc.enqueueRun(account, { tasks: ['login'] });
  const s = jobsSvc.enqueueSync(account);
  assert.ok(s.jobId);
  const rows = repo.jobs.recent({ accountId: account.id, limit: 10 });
  assert.equal(rows.filter((j) => j.type === 'run').length, 1);
  assert.equal(rows.filter((j) => j.type === 'sync').length, 1);
});

test('作业结束后可以再次入队（索引只约束活跃态）', () => {
  const { account } = makeAccount('c3');
  const first = jobsSvc.enqueueRun(account, { tasks: ['login'] }).jobId;
  repo.jobs.finish(first, { status: 'done', result: { ok: true } });
  const second = jobsSvc.enqueueRun(account, { tasks: ['login'] });
  assert.notEqual(second.jobId, first);
  assert.equal(second.reused, false);
});

test('并发扫码回调只绑一个账号，不抛 500', async () => {
  const v = repo.visitors.create({ maxAccounts: 5 });
  const payload = { visitorId: v.id, uid: 'same-uid', nick: '并发', cookieEnc: 'enc' };
  const results = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve().then(() => repo.accounts.ensure(payload))));
  assert.equal(results.filter(Boolean).length, 5);
  const list = repo.accounts.listByVisitor(v.id);
  assert.equal(list.length, 1, '只应有一个账号');
});

test('abort 后驱动立即停止，不会把剩余任务跑完', async () => {
  const { account } = makeAccount('c4');
  const jobId = jobsSvc.enqueueRun(account, { tasks: ['article', 'video'] }).jobId;
  const job = repo.jobs.get(jobId);
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 220);
  await assert.rejects(
    () =>
      jobsSvc.runJob(job, {
        signal: ac.signal,
        onEvent: () => {},
      }),
    (e) => e.code === 'ABORTED' || /abort/i.test(e.message),
  );
  assert.ok(Date.now() - started < 2000, '应该很快退出');
});

test('分数单调守卫：旧快照不许覆盖新快照', () => {
  const { account } = makeAccount('s1');
  const newer = { day: '2026-11-06', total: 100, today: 40, tasks: { 1: { name: '阅读文章', done: 12, max: 12 } } };
  const older = { day: '2026-11-06', total: 90, today: 30, tasks: {} };
  assert.equal(repo.accounts.saveScore(account.id, newer, 2000), 1);
  assert.equal(repo.accounts.saveScore(account.id, older, 1000), 0, '旧快照应被丢弃');
  const row = repo.accounts.get(account.id);
  assert.equal(row.score_today, 40);
  assert.equal(row.score_seq, 2000);

  // 同序号的并发写：后者胜出（<= 语义），不会两边都失败
  assert.equal(repo.accounts.saveScore(account.id, { ...newer, today: 41 }, 2000), 1);
  assert.equal(repo.accounts.get(account.id).score_today, 41);
});

test('账号租约：跨进程互斥 + 过期可被接管', () => {
  const { account } = makeAccount('l1');
  assert.equal(repo.accounts.acquireLease(account.id, 'w-a', 60_000), true);
  assert.equal(repo.accounts.acquireLease(account.id, 'w-b', 60_000), false, '第二个 worker 抢不到');
  repo.accounts.releaseLease(account.id, 'w-b'); // 不是持有者，不应释放
  assert.equal(repo.accounts.acquireLease(account.id, 'w-b', 60_000), false);
  repo.accounts.releaseLease(account.id, 'w-a');
  assert.equal(repo.accounts.acquireLease(account.id, 'w-b', 60_000), true);

  // 过期租约：把 locked_until 拨到过去，另一进程应能接管
  getDb()
    .prepare('UPDATE accounts SET locked_until = ? WHERE id = ?')
    .run(Date.now() - 1000, account.id);
  assert.ok(repo.accounts.expireLeases() >= 1);
  assert.equal(repo.accounts.acquireLease(account.id, 'w-c', 60_000), true);
});

test('requeueDead 返回被回收的作业（供 worker 打事件）', () => {
  const { account } = makeAccount('r1');
  const jobId = jobsSvc.enqueueRun(account, { tasks: ['login'] }).jobId;
  getDb().prepare("UPDATE jobs SET status='running', worker_id='dead-w', started_at=? WHERE id=?").run(Date.now(), jobId);
  const freed = repo.jobs.requeueDead(90_000);
  assert.ok(freed.some((j) => j.id === jobId), '应回收该作业');
  assert.equal(repo.jobs.get(jobId).status, 'queued');
});
