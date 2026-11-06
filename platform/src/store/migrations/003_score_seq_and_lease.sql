-- 003_score_seq_and_lease.sql
-- 目的 1：分数写入单调守卫——旧快照不许覆盖新快照（sync 与 run 会并发写同一账号）。
-- 目的 2：账号级租约锁——跨 worker 进程串行化同一账号，避免同账号被双端驱动。

ALTER TABLE accounts ADD COLUMN score_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN locked_by TEXT;
ALTER TABLE accounts ADD COLUMN locked_until INTEGER;

-- 租约查询走索引
CREATE INDEX IF NOT EXISTS idx_accounts_lease ON accounts(locked_until);
