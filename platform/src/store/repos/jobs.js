import { d, now, parse, j } from './_util.js';
import { randomId } from '../../crypto.js';

export const jobs = {
  enqueue({ type, visitorId = null, accountId = null, payload = null, maxAttempts = 2 }) {
    const id = randomId(9);
    d()
      .prepare('INSERT INTO jobs (id, type, visitor_id, account_id, status, payload, max_attempts, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, type, visitorId, accountId, 'queued', j(payload), maxAttempts, now());
    return id;
  },
  get(id) {
    return d().prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
  },
  /** 原子领取：一条 UPDATE 拿到队首，避免多 worker 抢同一单 */
  claim(workerId) {
    return (
      d()
        .prepare(
          `UPDATE jobs SET status = 'running', worker_id = ?, started_at = ?, attempts = attempts + 1
           WHERE id = (
             SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
           ) AND status = 'queued'
           RETURNING *`,
        )
        .get(workerId, now()) || null
    );
  },
  finish(id, { status = 'done', result = null, error = null } = {}) {
    d()
      .prepare('UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, j(result), error ? String(error).slice(0, 2000) : null, now(), id);
  },
  retry(id) {
    d().prepare("UPDATE jobs SET status = 'queued', worker_id = NULL, started_at = NULL WHERE id = ?").run(id);
  },
  activeForAccount(accountId) {
    return (
      d()
        .prepare("SELECT * FROM jobs WHERE account_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
        .get(accountId) || null
    );
  },
  /**
   * 幂等入队：靠部分唯一索引 uq_jobs_active_run 在**数据库层**保证
   * 「一个账号同时只有一个活跃 run」。INSERT OR IGNORE 抢不到就返回已有那条。
   * 这样即使 API 多进程 / 调度与手动点击并发，也不会产生重复作业。
   */
  enqueueRunOnce({ visitorId = null, accountId, payload = null, maxAttempts = 2 }) {
    const id = randomId(9);
    const info = d()
      .prepare(
        `INSERT OR IGNORE INTO jobs (id, type, visitor_id, account_id, status, payload, max_attempts, created_at)
         VALUES (?, 'run', ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, visitorId, accountId, j(payload), maxAttempts, now());
    if (info.changes > 0) return { id, reused: false };
    const existing =
      d()
        .prepare("SELECT id FROM jobs WHERE account_id = ? AND type = 'run' AND status IN ('queued','running') LIMIT 1")
        .get(accountId) || null;
    return { id: existing?.id ?? null, reused: true };
  },
  recent({ accountId = null, limit = 20 } = {}) {
    if (accountId) {
      return d().prepare('SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit);
    }
    return d().prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  /** 指标用：数据库侧聚合，别再拉全表到 Node 里 filter */
  countByStatus() {
    const rows = d().prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
    const out = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  },
  /**
   * 回收 worker 已经不心跳的 running 任务。
   * 返回被回收的作业（id/account_id），调用方据此打事件，避免「作业悄悄换了个状态」。
   */
  requeueDead(staleMs) {
    return d()
      .prepare(
        `UPDATE jobs SET status = 'queued', worker_id = NULL, started_at = NULL
         WHERE status = 'running'
           AND (worker_id IS NULL OR worker_id NOT IN (SELECT id FROM workers WHERE seen_at > ?))
         RETURNING id, account_id, worker_id`,
      )
      .all(now() - staleMs);
  },
  publicView(job) {
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      accountId: job.account_id,
      payload: parse(job.payload, null),
      result: parse(job.result, job.result),
      error: job.error,
      attempts: job.attempts,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    };
  },
};
