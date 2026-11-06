import { Router } from 'express';
import { jobs, events } from '../../store/repo.js';
import { needApproved } from '../../services/session.js';
import { h } from '../middleware.js';
import { openSse } from '../sse.js';
import { notFound, forbidden } from '../../errors.js';

export const jobsRouter = Router();
jobsRouter.use(needApproved);

function ownedJob(req) {
  const job = jobs.get(req.params.id);
  if (!job) throw notFound('作业不存在');
  if (job.visitor_id && job.visitor_id !== req.visitor.id) throw forbidden();
  return job;
}

jobsRouter.get(
  '/:id',
  h(async (req, res) => {
    const job = ownedJob(req);
    res.json({ job: jobs.publicView(job), events: events.after(job.id, 0, 100) });
  }),
);

/**
 * 作业日志 SSE：先补历史，再增量推送；作业结束后关闭。
 * 这是产品体验的核心——用户点「开始」，能看到一行行走出来。
 */
jobsRouter.get(
  '/:id/events',
  h(async (req, res) => {
    const job = ownedJob(req);
    const { send, close } = openSse(req, res);
    let seq = Number(req.query.after) || 0;
    let stopped = false;
    req.on('close', () => {
      stopped = true;
    });
    const loop = async () => {
      while (!stopped) {
        const rows = events.after(job.id, seq, 100);
        for (const e of rows) {
          seq = e.seq;
          send('log', e);
        }
        const cur = jobs.get(job.id);
        if (cur && ['done', 'failed', 'cancelled'].includes(cur.status)) {
          send('done', { status: cur.status, result: cur.result, error: cur.error });
          break;
        }
        await new Promise((x) => setTimeout(x, 800));
      }
      close();
    };
    loop();
  }),
);

jobsRouter.get(
  '/',
  h(async (req, res) => {
    const accountId = req.query.account || null;
    const list = jobs.recent({ accountId, limit: Number(req.query.limit) || 20 });
    res.json({ jobs: list.map(jobs.publicView) });
  }),
);
