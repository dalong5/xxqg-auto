import { d, now } from './_util.js';
import { randomId } from '../../crypto.js';

export const visitors = {
  create({ code = null, approved = 1, maxAccounts = 1, note = null } = {}) {
    const id = randomId(9);
    d()
      .prepare('INSERT INTO visitors (id, code, approved, max_accounts, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, code, approved ? 1 : 0, maxAccounts, note, now());
    return this.get(id);
  },
  get(id) {
    return d().prepare('SELECT * FROM visitors WHERE id = ?').get(id) || null;
  },
  byCode(code) {
    return d().prepare('SELECT * FROM visitors WHERE code = ?').get(code) || null;
  },
  touch(id) {
    d().prepare('UPDATE visitors SET seen_at = ? WHERE id = ?').run(now(), id);
  },
  approve(id, approved = true) {
    d().prepare('UPDATE visitors SET approved = ? WHERE id = ?').run(approved ? 1 : 0, id);
    return this.get(id);
  },
  setQuota(id, n) {
    d().prepare('UPDATE visitors SET max_accounts = ? WHERE id = ?').run(n, id);
    return this.get(id);
  },
  /** 列表带上账号数：一次 LEFT JOIN 聚合，避免每个访客再查一次（N+1） */
  list({ limit = 100 } = {}) {
    return d()
      .prepare(
        `SELECT v.*, COUNT(a.id) AS account_count
         FROM visitors v LEFT JOIN accounts a ON a.visitor_id = v.id AND a.status != 'disabled'
         GROUP BY v.id ORDER BY v.created_at DESC LIMIT ?`,
      )
      .all(limit);
  },
  countAccounts(id) {
    return d().prepare('SELECT COUNT(*) AS n FROM accounts WHERE visitor_id = ? AND status != ?').get(id, 'disabled').n;
  },
};
