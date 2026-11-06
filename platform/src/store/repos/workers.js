import { d, now } from './_util.js';

export const workers = {
  beat(id, { host, pid, concurrency }) {
    const t = now();
    // upsert：一条语句完成「有则更新、无则插入」，比先查后写少一次往返
    d()
      .prepare(
        `INSERT INTO workers (id, host, pid, concurrency, started_at, seen_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET seen_at = excluded.seen_at, concurrency = excluded.concurrency`,
      )
      .run(id, host, pid, concurrency, t, t);
  },
  alive(staleMs) {
    return d().prepare('SELECT COUNT(*) AS n FROM workers WHERE seen_at > ?').get(now() - staleMs).n;
  },
  prune(staleMs) {
    return d().prepare('DELETE FROM workers WHERE seen_at < ?').run(now() - staleMs * 4).changes;
  },
};
