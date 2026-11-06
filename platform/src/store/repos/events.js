import { d, now, j } from './_util.js';

export const events = {
  add({ jobId = null, accountId = null, level = 'info', type, message = null, payload = null }) {
    const info = d()
      .prepare('INSERT INTO job_events (job_id, account_id, level, type, message, payload, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(jobId, accountId, level, type, message, j(payload), now());
    return Number(info.lastInsertRowid);
  },
  /** SSE 增量游标：seq > after，天然支持断线重连 */
  after(jobId, seq = 0, limit = 200) {
    return d()
      .prepare('SELECT seq, level, type, message, payload, created_at FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(jobId, seq, limit);
  },
  recentForAccount(accountId, limit = 100) {
    return d()
      .prepare('SELECT seq, level, type, message, payload, created_at FROM job_events WHERE account_id = ? ORDER BY seq DESC LIMIT ?')
      .all(accountId, limit)
      .reverse();
  },
  trim(days = 7) {
    return d().prepare('DELETE FROM job_events WHERE created_at < ?').run(now() - days * 86400_000).changes;
  },
};
