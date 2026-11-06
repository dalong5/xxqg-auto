-- 001_init.sql —— 初始 schema（SQLite / WAL）。
-- 约定：所有时间戳为毫秒整数（INTEGER），所有主键为 TEXT（uuid/nanoid），JSON 字段存 TEXT。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 访客 = 我们的终端用户（MVP 单层租户，不做组织）
CREATE TABLE IF NOT EXISTS visitors (
  id            TEXT PRIMARY KEY,
  code          TEXT UNIQUE,                 -- 邀请码（可空）
  approved      INTEGER NOT NULL DEFAULT 1,
  max_accounts  INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  seen_at       INTEGER
);

-- 平台账号（一个访客可以有 N 个，受 max_accounts 限制）
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  visitor_id    TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL DEFAULT 'xxqg',
  uid           TEXT NOT NULL,               -- 平台侧 uid
  nick          TEXT,
  cookie_enc    TEXT NOT NULL,               -- AES-256-GCM 密封的 cookie JSON
  status        TEXT NOT NULL DEFAULT 'active', -- active | expired | disabled
  day           TEXT,                        -- 最近一次分数所属日期 YYYY-MM-DD
  score_total   INTEGER NOT NULL DEFAULT 0,
  score_today   INTEGER NOT NULL DEFAULT 0,
  score_json    TEXT,                        -- 最近一次完整任务分数
  last_sync_at  INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (visitor_id, platform, uid)
);
CREATE INDEX IF NOT EXISTS idx_accounts_visitor ON accounts(visitor_id);

-- 扫码登录会话（一次性）
CREATE TABLE IF NOT EXISTS login_sessions (
  sid           TEXT PRIMARY KEY,
  visitor_id    TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL DEFAULT 'xxqg',
  status        TEXT NOT NULL DEFAULT 'waiting', -- waiting | scanned | done | failed | expired
  qr            TEXT,                        -- 二维码内容（前端渲染）
  account_id    TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_status ON login_sessions(status, expires_at);

-- 定时任务（一个账号可有多条，MVP UI 只编辑一条）
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  visitor_id    TEXT NOT NULL,
  at            TEXT NOT NULL,               -- "HH:MM"
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_run_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (account_id)
);

-- 作业队列（DB 即队列，够 MVP；扩容换成 Redis/SQS 时保持字段语义）
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,               -- run | login | sync | selftest
  visitor_id    TEXT,
  account_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | cancelled
  payload       TEXT,
  result        TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 2,
  worker_id     TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id, created_at DESC);

-- 作业事件（SSE 日志 / 审计）
CREATE TABLE IF NOT EXISTS job_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT,
  account_id    TEXT,
  level         TEXT NOT NULL DEFAULT 'info',
  type          TEXT NOT NULL,
  message       TEXT,
  payload       TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_time ON job_events(created_at);

-- worker 心跳（用于回收僵死任务）
CREATE TABLE IF NOT EXISTS workers (
  id            TEXT PRIMARY KEY,
  host          TEXT,
  pid           INTEGER,
  concurrency   INTEGER,
  started_at    INTEGER NOT NULL,
  seen_at       INTEGER NOT NULL
);

-- 审计：谁对谁做了什么（MVP 只记关键动作）
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor         TEXT,
  action        TEXT NOT NULL,
  target        TEXT,
  meta          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
