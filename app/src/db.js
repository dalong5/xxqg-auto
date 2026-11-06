import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';
import { seal } from './crypto.js';

const file = path.join(config.dataDir, 'app.db');
export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS verification_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_verification_job ON verification_actions(job_id);

  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    uid TEXT PRIMARY KEY,
    visitor_id TEXT NOT NULL,
    nick TEXT,
    sealed_cookie TEXT NOT NULL,
    expires_at INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_run_at INTEGER DEFAULT 0,
    last_score TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_users_visitor ON users(visitor_id);

  CREATE TABLE IF NOT EXISTS logins (
    sid TEXT PRIMARY KEY,
    visitor_id TEXT NOT NULL,
    status TEXT NOT NULL,
    code TEXT,
    state TEXT,
    jar TEXT,
    uid TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logins_status ON logins(status);

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    uid TEXT,
    visitor_id TEXT,
    kind TEXT NOT NULL,
    tasks TEXT,
    status TEXT NOT NULL,
    worker TEXT,
    attempts INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    uid TEXT,
    type TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, seq);

  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedules (
    visitor_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    times TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scheduled_runs (
    uid TEXT NOT NULL,
    run_day TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (uid, run_day)
  );
  CREATE TABLE IF NOT EXISTS schedule_pauses (
    uid TEXT PRIMARY KEY,
    reason TEXT NOT NULL
  );
`);

// 老库补列，保留已有账号和密钥。
db.exec('BEGIN IMMEDIATE');
try {
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!userColumns.has('score_day')) db.exec('ALTER TABLE users ADD COLUMN score_day TEXT');
  if (!userColumns.has('login_generation')) db.exec('ALTER TABLE users ADD COLUMN login_generation INTEGER NOT NULL DEFAULT 0');
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }

const now = () => Date.now();

// ---------- 访客会话（多人同时用，各自只看自己的账号） ----------
export function touchVisitor(id) {
  db.prepare('INSERT OR IGNORE INTO visitors (id, created_at) VALUES (?, ?)').run(id, now());
}

// ---------- 扫码登录 ----------
export function createLogin(visitorId) {
  const sid = crypto.randomUUID().replaceAll('-', '');
  db.prepare(
    'INSERT INTO logins (sid, visitor_id, status, created_at) VALUES (?, ?, ?, ?)',
  ).run(sid, visitorId, 'starting', now());
  return getLogin(sid);
}

export const getLogin = (sid) => db.prepare('SELECT * FROM logins WHERE sid = ?').get(sid) || null;

export function updateLogin(sid, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sql = `UPDATE logins SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE sid = ?`;
  db.prepare(sql).run(...keys.map((k) => patch[k]), sid);
}

export const deleteStaleLogins = () => {
  const expired = db.prepare("UPDATE logins SET status = 'failed', error = '登录会话已过期，请重新生成二维码' WHERE status IN ('starting','init','waiting') AND created_at < ? RETURNING sid").all(now() - 180_000);
  for (const row of expired) addEvent(row.sid, null, 'failed', { error: '登录会话已过期，请重新生成二维码' });
  // 成功的登录会话保留 7 天：它的 jar 是明文，可作为密钥轮换后恢复 cookie 的备份
  db.prepare("DELETE FROM logins WHERE status = 'done' AND created_at < ?").run(now() - 7 * 86400_000);
  db.prepare("DELETE FROM logins WHERE status IN ('failed','expired') AND created_at < ?").run(now() - 3600_000);
};

// ---------- 用户 ----------
export function upsertUser({ uid, visitorId, nick, jar, expiresAt }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = getUser(uid);
    if (existing?.visitor_id !== visitorId && countUsers(visitorId) >= config.maxAccounts) {
      throw new Error(`最多绑定 ${config.maxAccounts} 个账号`);
    }
    db.prepare(
      `INSERT INTO users (uid, visitor_id, nick, sealed_cookie, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         visitor_id = excluded.visitor_id,
         nick = excluded.nick,
         sealed_cookie = excluded.sealed_cookie,
         expires_at = excluded.expires_at,
         login_generation = users.login_generation + 1`,
    ).run(uid, visitorId, nick, seal(typeof jar === 'string' ? JSON.parse(jar) : jar), expiresAt, now());
    db.prepare("UPDATE jobs SET status = 'failed', finished_at = ?, error = '账号归属已更新，原浏览器的暂停任务已停止' WHERE uid = ? AND visitor_id != ? AND status = 'paused'").run(now(), uid, visitorId);
    db.prepare('DELETE FROM schedule_pauses WHERE uid = ?').run(uid);
    db.exec('COMMIT');
    return getUser(uid);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export const getUser = (uid) => db.prepare('SELECT * FROM users WHERE uid = ?').get(uid) || null;
export const listUsers = (visitorId) =>
  db
    .prepare("SELECT uid, nick, expires_at, created_at, last_run_at, CASE WHEN score_day = ? THEN last_score ELSE NULL END AS last_score, (SELECT id FROM jobs WHERE jobs.uid = users.uid AND status IN ('queued','running','pausing','paused') LIMIT 1) AS active_job, (SELECT status FROM jobs WHERE jobs.uid = users.uid AND status IN ('queued','running','pausing','paused') LIMIT 1) AS active_job_status FROM users WHERE visitor_id = ? ORDER BY created_at DESC")
    .all(today(), visitorId);
export const countUsers = (visitorId) =>
  db.prepare('SELECT COUNT(*) AS n FROM users WHERE visitor_id = ?').get(visitorId).n;

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** 当天分数只增不减：并发的旧快照不能把新分数冲掉 */
export const setUserScore = (uid, score) => {
  const row = db.prepare('SELECT last_score, score_day FROM users WHERE uid = ?').get(uid);
  const day = today();
  if (row?.score_day === day && row.last_score) {
    const prev = JSON.parse(row.last_score);
    if ((prev?.total ?? 0) > (score?.total ?? 0)) {
      db.prepare('UPDATE users SET last_run_at = ? WHERE uid = ?').run(now(), uid);
      return false;
    }
  }
  db.prepare('UPDATE users SET last_score = ?, score_day = ?, last_run_at = ? WHERE uid = ?').run(
    JSON.stringify(score),
    day,
    now(),
    uid,
  );
  return true;
};
export const deleteUser = (uid, visitorId) =>
  db.prepare("DELETE FROM users WHERE uid = ? AND visitor_id = ? AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.uid = users.uid AND status IN ('queued','running','pausing','paused'))").run(uid, visitorId);

// ---------- 任务队列（跨进程原子领取） ----------
function insertJob({ kind, uid = null, visitorId, tasks = null }, at = now()) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO jobs (id, uid, visitor_id, kind, tasks, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
  ).run(id, uid, visitorId, kind, tasks ? JSON.stringify(tasks) : null, at);
  return id;
}

export function enqueue({ kind, uid = null, visitorId, tasks = null }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (uid) {
      const active = db.prepare("SELECT id FROM jobs WHERE uid = ? AND status IN ('queued','running','pausing','paused') LIMIT 1").get(uid);
      if (active) {
        db.exec('COMMIT');
        return active.id;
      }
    }
    const id = insertJob({ kind, uid, visitorId, tasks });
    db.exec('COMMIT');
    return id;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 保留旧计划记录用于审计，升级后不得重新执行旧自动任务。
export function scheduledJobError(job) {
  return db.prepare('SELECT 1 FROM scheduled_runs WHERE job_id = ?').get(job.id)
    ? '每周自动任务已移除，该历史计划任务已停止'
    : null;
}

export function claimJob(kind, workerId) {
  const row = db
    .prepare(
      `UPDATE jobs SET status = 'running', worker = ?, started_at = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'queued' AND kind = ?
         ORDER BY created_at LIMIT 1
       ) AND status = 'queued'
       RETURNING *`,
    )
    .get(workerId, now(), kind);
  return row || null;
}

export const finishJob = (id) =>
  db.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ? AND status = 'running' RETURNING status").get(now(), id) || finishPausedJob(id);
export const requestJobPause = (id, visitorId) =>
  db.prepare(`UPDATE jobs SET status = CASE WHEN status IN ('queued','paused') THEN 'paused' ELSE 'pausing' END
    WHERE id = ? AND kind = 'run' AND status IN ('queued','running','pausing','paused')
      AND visitor_id = ? AND EXISTS (SELECT 1 FROM users WHERE uid = jobs.uid AND visitor_id = ?)
    RETURNING status`).get(id, visitorId, visitorId);
export function finishPausedJob(id) {
  const owned = 'EXISTS (SELECT 1 FROM users WHERE uid = jobs.uid AND visitor_id = jobs.visitor_id)';
  const result = db.prepare(`UPDATE jobs SET status = CASE WHEN ${owned} THEN 'paused' ELSE 'failed' END,
    finished_at = CASE WHEN ${owned} THEN NULL ELSE ? END,
    error = CASE WHEN ${owned} THEN NULL ELSE '账号归属已更新，原浏览器的暂停任务已停止' END
    WHERE id = ? AND status = 'pausing' RETURNING status, uid, error`).get(now(), id);
  if (result?.status === 'failed') addEvent(id, result.uid, 'error', { error: result.error });
  return result;
}
export const resumeJob = (id, visitorId) =>
  db.prepare(`UPDATE jobs SET status = 'queued', worker = NULL, started_at = NULL, finished_at = NULL, error = NULL, attempts = 0
    WHERE id = ? AND kind = 'run' AND status = 'paused'
      AND visitor_id = ? AND EXISTS (SELECT 1 FROM users WHERE uid = jobs.uid AND visitor_id = ?)
    RETURNING status`).get(id, visitorId, visitorId);
export const failJob = (id, error, retry = false) =>
  retry
    ? db.prepare("UPDATE jobs SET status = 'queued', error = ?, started_at = NULL WHERE id = ?").run(String(error), id)
    : db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(String(error), now(), id);
export const getJob = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
export const queuedCount = () => db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get().n;

// ---------- worker 心跳 ----------
export const beat = (workerId) =>
  db
    .prepare('INSERT INTO workers (id, seen_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET seen_at = excluded.seen_at')
    .run(workerId, now());
export const liveWorkers = () =>
  db.prepare('SELECT COUNT(*) AS n FROM workers WHERE seen_at > ?').get(now() - 90_000).n;
const pruneWorkers = () => db.prepare('DELETE FROM workers WHERE seen_at < ?').run(now() - 600_000);

/**
 * 回收死掉进程留下的 running 任务。
 * 只回收心跳已停的 worker，避免把别人正在跑的任务抢走。
 */
export function requeueDeadJobs() {
  const interrupted = db.prepare(`UPDATE jobs SET
      status = CASE WHEN status = 'pausing' THEN 'pausing' WHEN attempts < 2 THEN 'queued' ELSE 'failed' END,
      started_at = CASE WHEN status = 'pausing' OR attempts < 2 THEN NULL ELSE started_at END,
      finished_at = CASE WHEN status = 'pausing' OR attempts < 2 THEN NULL ELSE ? END,
      error = CASE WHEN status = 'pausing' OR attempts < 2 THEN error ELSE '执行器多次中断，任务已停止，请检查服务器资源后手动重试' END
    WHERE status IN ('running','pausing')
      AND (worker IS NULL OR worker NOT IN (SELECT id FROM workers WHERE seen_at > ?))
    RETURNING id, uid, status, error`).all(now(), now() - 90_000);
  for (const job of interrupted) {
    if (job.status === 'failed') addEvent(job.id, job.uid, 'error', { error: job.error });
    if (job.status === 'pausing' && finishPausedJob(job.id)?.status === 'paused') addEvent(job.id, job.uid, 'log', { text: '执行器中断，任务保持暂停，请手动继续' });
  }
  pruneWorkers();
  return interrupted.length;
}

// ---------- 事件流 ----------
export const addEvent = (jobId, uid, type, payload = null) =>
  db.prepare('INSERT INTO events (job_id, uid, type, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(
    jobId,
    uid,
    type,
    payload ? JSON.stringify(payload) : null,
    now(),
  );

export const eventsAfter = (jobId, after = 0) =>
  db.prepare('SELECT seq, type, payload, created_at FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT 200').all(jobId, after);

export const trimEvents = () => db.prepare('DELETE FROM events WHERE created_at < ?').run(now() - 24 * 3600_000);
