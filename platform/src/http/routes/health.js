import { Router } from 'express';
import { getDb } from '../../store/db.js';
import { config } from '../../config.js';
import { jobs, workers, accounts } from '../../store/repo.js';

export const healthRouter = Router();

healthRouter.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), at: Date.now() });
});

/** ready = DB 可用 + 至少一个 worker 心跳（没有 worker 时任务只会排队） */
healthRouter.get('/readyz', (_req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    const alive = workers.alive(config.workerStaleMs);
    const queued = jobs.countByStatus().queued;
    const ready = alive > 0;
    res.status(ready ? 200 : 503).json({ ready, db: 'ok', workers: alive, queued, at: Date.now() });
  } catch (e) {
    res.status(503).json({ ready: false, db: 'error', error: e.message });
  }
});

/** Prometheus 文本格式：全部走 SQL 聚合，不把明细表拉进内存 */
healthRouter.get('/metrics', (_req, res) => {
  const by = jobs.countByStatus();
  const all = accounts.listAll();
  const lines = [
    '# HELP xxqg_jobs_total 作业数（按状态）',
    '# TYPE xxqg_jobs_total gauge',
    `xxqg_jobs_total{status="queued"} ${by.queued}`,
    `xxqg_jobs_total{status="running"} ${by.running}`,
    `xxqg_jobs_total{status="done"} ${by.done}`,
    `xxqg_jobs_total{status="failed"} ${by.failed}`,
    '# HELP xxqg_workers_alive 心跳正常的 worker 数',
    '# TYPE xxqg_workers_alive gauge',
    `xxqg_workers_alive ${workers.alive(config.workerStaleMs)}`,
    '# HELP xxqg_accounts_total 绑定账号数',
    '# TYPE xxqg_accounts_total gauge',
    `xxqg_accounts_total ${all.length}`,
    '# HELP xxqg_score_today_sum 今日总积分（所有账号）',
    '# TYPE xxqg_score_today_sum gauge',
    `xxqg_score_today_sum ${all.reduce((n, a) => n + (a.score_today || 0), 0)}`,
    '# HELP process_uptime_seconds 进程运行时长',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${Math.round(process.uptime())}`,
    '',
  ];
  res.type('text/plain; version=0.0.4').send(lines.join('\n'));
});
