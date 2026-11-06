import { d, now, parse, j } from './_util.js';
import { randomId } from '../../crypto.js';

export const accounts = {
  create({ visitorId, uid, nick, cookieEnc, platform = 'xxqg' }) {
    const id = randomId(9);
    d()
      .prepare(
        'INSERT INTO accounts (id, visitor_id, platform, uid, nick, cookie_enc, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, visitorId, platform, uid, nick || null, cookieEnc, 'active', now());
    return this.get(id);
  },
  get(id) {
    return d().prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
  },
  byUid(visitorId, uid, platform = 'xxqg') {
    return d().prepare('SELECT * FROM accounts WHERE visitor_id = ? AND uid = ? AND platform = ?').get(visitorId, uid, platform) || null;
  },
  /**
   * 幂等绑定：并发扫码 / 双开页面同时回调时，靠唯一约束 (visitor_id, platform, uid)
   * 保证只插一条；抢不到就更新已有那条的 cookie。
   */
  ensure({ visitorId, uid, nick, cookieEnc, platform = 'xxqg' }) {
    const id = randomId(9);
    d()
      .prepare(
        `INSERT OR IGNORE INTO accounts (id, visitor_id, platform, uid, nick, cookie_enc, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, visitorId, platform, uid, nick || null, cookieEnc, 'active', now());
    const row = this.byUid(visitorId, uid, platform);
    if (row && row.cookie_enc !== cookieEnc) {
      d().prepare('UPDATE accounts SET cookie_enc = ?, status = ?, last_sync_at = ? WHERE id = ?').run(cookieEnc, 'active', now(), row.id);
      return this.get(row.id);
    }
    return row;
  },
  listByVisitor(visitorId) {
    return d()
      .prepare('SELECT * FROM accounts WHERE visitor_id = ? AND status != ? ORDER BY created_at ASC')
      .all(visitorId, 'disabled');
  },
  /**
   * 带定时的列表：一条 SQL 拿完，替代「先查账号再逐个查 schedules」的 N+1。
   * 返回的 schedule_* 字段由 listWithSchedule 组装成 schedule 对象。
   */
  listWithSchedule(visitorId) {
    const rows = d()
      .prepare(
        `SELECT a.*, s.at AS schedule_at, s.next_run_at AS schedule_next
         FROM accounts a LEFT JOIN schedules s ON s.account_id = a.id
         WHERE a.visitor_id = ? AND a.status != 'disabled'
         ORDER BY a.created_at ASC`,
      )
      .all(visitorId);
    return rows.map((r) => {
      const view = this.publicView(r);
      view.schedule = r.schedule_at ? { at: r.schedule_at, nextRunAt: r.schedule_next } : null;
      return view;
    });
  },
  listAll() {
    return d().prepare('SELECT * FROM accounts ORDER BY created_at DESC LIMIT 500').all();
  },
  updateCookie(id, cookieEnc) {
    d().prepare('UPDATE accounts SET cookie_enc = ?, status = ?, last_sync_at = ? WHERE id = ?').run(cookieEnc, 'active', now(), id);
  },
  setStatus(id, status) {
    d().prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id);
  },
  saveScore(id, { day, total, today, tasks }, seq = now()) {
    // 单调守卫：sync 与 run 可能并发写同一账号，只让「更新的快照」落库，
    // 否则一次慢请求返回的旧分数会把刚拿到的分覆盖回去（app 工程里踩过）。
    return d()
      .prepare(
        `UPDATE accounts
         SET day = ?, score_total = ?, score_today = ?, score_json = ?, last_sync_at = ?, score_seq = ?
         WHERE id = ? AND score_seq <= ?`,
      )
      .run(day || null, total ?? 0, today ?? 0, j(tasks), now(), seq, id, seq).changes;
  },
  /**
   * 账号级租约：跨进程串行化的兜底。
   * 抢到返回 true；被人持有且未过期返回 false（调用方应把作业放回队列）。
   */
  acquireLease(id, owner, ttlMs) {
    const t = now();
    return (
      d()
        .prepare('UPDATE accounts SET locked_by = ?, locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)')
        .run(owner, t + ttlMs, id, t).changes > 0
    );
  },
  releaseLease(id, owner) {
    d().prepare('UPDATE accounts SET locked_by = NULL, locked_until = NULL WHERE id = ? AND locked_by = ?').run(id, owner);
  },
  /** 顺手清掉过期租约（worker 心跳里调用） */
  expireLeases() {
    return d().prepare('UPDATE accounts SET locked_by = NULL, locked_until = NULL WHERE locked_until IS NOT NULL AND locked_until < ?').run(now())
      .changes;
  },
  remove(id) {
    d().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  },
  /** 对外视图：不泄露 cookie_enc，字段名转 camelCase */
  publicView(a) {
    if (!a) return null;
    return {
      id: a.id,
      uid: a.uid,
      nick: a.nick,
      platform: a.platform,
      status: a.status,
      day: a.day,
      scoreTotal: a.score_total,
      scoreToday: a.score_today,
      tasks: parse(a.score_json, {}),
      lastSyncAt: a.last_sync_at,
      createdAt: a.created_at,
    };
  },
};
