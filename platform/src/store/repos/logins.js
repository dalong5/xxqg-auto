import { d, now } from './_util.js';
import { randomId } from '../../crypto.js';

export const logins = {
  create({ visitorId, platform = 'xxqg', qr = null, ttlMs }) {
    const sid = randomId(12);
    const t = now();
    d()
      .prepare('INSERT INTO login_sessions (sid, visitor_id, platform, status, qr, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sid, visitorId, platform, 'waiting', qr, t, t, t + ttlMs);
    return this.get(sid);
  },
  get(sid) {
    return d().prepare('SELECT * FROM login_sessions WHERE sid = ?').get(sid) || null;
  },
  /** 白名单字段更新：拒绝任意列名拼进 SQL */
  update(sid, fields) {
    const allowed = new Set(['status', 'qr', 'account_id', 'error']);
    const keys = Object.keys(fields).filter((k) => allowed.has(k));
    if (!keys.length) return this.get(sid);
    const sql = `UPDATE login_sessions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE sid = ?`;
    d()
      .prepare(sql)
      .run(...keys.map((k) => fields[k]), now(), sid);
    return this.get(sid);
  },
  /** 批量过期：调度器每分钟调用，避免 waiting 记录无限堆积 */
  expireStale() {
    return d()
      .prepare("UPDATE login_sessions SET status = 'expired' WHERE status IN ('waiting','scanned') AND expires_at < ?")
      .run(now()).changes;
  },
};
