import { d, now } from './_util.js';
import { randomId } from '../../crypto.js';

/** 一行 = 一个账号的每日定时；upsert 保证「一个账号只有一条」 */
export const schedules = {
  upsert({ accountId, visitorId, at, nextRunAt }) {
    const existing = d().prepare('SELECT id FROM schedules WHERE account_id = ?').get(accountId);
    if (existing) {
      d().prepare('UPDATE schedules SET at = ?, enabled = 1, next_run_at = ? WHERE account_id = ?').run(at, nextRunAt, accountId);
      return this.byAccount(accountId);
    }
    d()
      .prepare('INSERT INTO schedules (id, account_id, visitor_id, at, enabled, next_run_at, created_at) VALUES (?,?,?,?,1,?,?)')
      .run(randomId(9), accountId, visitorId, at, nextRunAt, now());
    return this.byAccount(accountId);
  },
  byAccount(accountId) {
    return d().prepare('SELECT * FROM schedules WHERE account_id = ?').get(accountId) || null;
  },
  remove(accountId) {
    d().prepare('DELETE FROM schedules WHERE account_id = ?').run(accountId);
  },
  /** 到点且账号可用的定时；只取调度需要的列 */
  due(t = now()) {
    return d()
      .prepare(
        `SELECT s.id, s.account_id, s.at, s.next_run_at, a.uid, a.nick
         FROM schedules s JOIN accounts a ON a.id = s.account_id
         WHERE s.enabled = 1 AND s.next_run_at <= ? AND a.status = 'active'
         ORDER BY s.next_run_at ASC`,
      )
      .all(t);
  },
  markRun(id, nextRunAt) {
    d().prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(nextRunAt, id);
  },
};
