-- 002_active_job_unique.sql
-- 目的：在数据库层强制「同一账号同时只能有一个排队/运行中的 run 作业」。
-- 背景：应用层的「先查 activeForAccount 再 enqueue」是 check-then-act，
--       在 API 多进程 / 调度与手动点击同时发生时会产生重复作业，
--       同一账号被两个 worker 同时驱动 → 站点风控「不支持多端同时作答」+ 分数不涨。

-- 先清理历史重复：每个账号只保留最新的一条活跃 run，其余标记 cancelled。
UPDATE jobs
SET status = 'cancelled',
    error = COALESCE(error, 'migration 002: duplicate active run'),
    finished_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE type = 'run'
  AND status IN ('queued', 'running')
  AND account_id IS NOT NULL
  AND id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC, id DESC) AS rn
      FROM jobs
      WHERE type = 'run' AND status IN ('queued', 'running') AND account_id IS NOT NULL
    ) WHERE rn = 1
  );

-- 部分唯一索引：只约束 run 类型的活跃作业；sync/其它类型不受影响。
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active_run
  ON jobs (account_id)
  WHERE type = 'run' AND status IN ('queued', 'running') AND account_id IS NOT NULL;
