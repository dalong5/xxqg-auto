import { Router } from 'express';
import { config } from '../../config.js';
import { visitors, jobs, accounts, workers, audit, events } from '../../store/repo.js';
import { h } from '../middleware.js';
import { forbidden } from '../../errors.js';
import { driverName } from '../../domain/index.js';

export const adminRouter = Router();

/**
 * MVP 的「管理员」= 持有 ADMIN_TOKEN 的人（运维/创始团队）。
 * 生产环境应换成 RBAC + SSO，这里保持最小可用并显式标注边界。
 */
adminRouter.use((req, _res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!config.adminToken || token !== config.adminToken) return next(forbidden('需要管理员令牌'));
  next();
});

adminRouter.get(
  '/overview',
  h(async (_req, res) => {
    res.json({
      driver: driverName(),
      env: config.env,
      visitors: visitors.list({ limit: 200 }).length,
      accounts: accounts.listAll().length,
      workers: workers.alive(config.workerStaleMs),
      jobs: {
        queued: jobs.recent({ limit: 500 }).filter((j) => j.status === 'queued').length,
        running: jobs.recent({ limit: 500 }).filter((j) => j.status === 'running').length,
      },
      at: Date.now(),
    });
  }),
);

adminRouter.get(
  '/visitors',
  h(async (_req, res) => {
    const list = visitors.list({ limit: 200 }).map((v) => ({
      ...v,
      accounts: visitors.countAccounts(v.id),
    }));
    res.json({ visitors: list });
  }),
);

adminRouter.post(
  '/visitors/:id/approve',
  h(async (req, res) => {
    const v = visitors.approve(req.params.id, req.body?.approved !== false);
    audit.add({ actor: 'admin', action: 'visitor.approve', target: v.id, meta: { approved: v.approved } });
    res.json({ ok: true, visitor: v });
  }),
);

adminRouter.post(
  '/visitors/:id/quota',
  h(async (req, res) => {
    const n = Math.max(1, Math.min(20, Number(req.body?.maxAccounts) || 1));
    const v = visitors.setQuota(req.params.id, n);
    audit.add({ actor: 'admin', action: 'visitor.quota', target: v.id, meta: { maxAccounts: n } });
    res.json({ ok: true, visitor: v });
  }),
);

adminRouter.get(
  '/audit',
  h(async (_req, res) => res.json({ audit: audit.list(200) })),
);

adminRouter.post(
  '/maintenance/trim',
  h(async (_req, res) => {
    res.json({ ok: true, events: events.trim(7), workers: workers.prune(config.workerStaleMs) });
  }),
);
