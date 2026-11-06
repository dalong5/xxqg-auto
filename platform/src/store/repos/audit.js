import { d, now, j } from './_util.js';

export const audit = {
  add({ actor, action, target = null, meta = null }) {
    d()
      .prepare('INSERT INTO audit_log (actor, action, target, meta, created_at) VALUES (?,?,?,?,?)')
      .run(actor || null, action, target, j(meta), now());
  },
  list(limit = 100) {
    return d().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  },
};
