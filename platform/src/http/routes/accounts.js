import { Router } from 'express';
import { rateLimit } from '../../services/session.js';
import { needApproved, guardWrites } from '../../services/session.js';
import { startLogin, pollLogin, listForVisitor, getOwned, removeAccount, setSchedule } from '../../services/accounts.js';
import { enqueueRun, enqueueSync } from '../../services/jobs.js';
import { events } from '../../store/repo.js';
import { h } from '../middleware.js';
import { openSse } from '../sse.js';
import { tooMany } from '../../errors.js';

export const accountsRouter = Router();
accountsRouter.use(needApproved);

accountsRouter.get(
  '/',
  h(async (req, res) => res.json({ accounts: listForVisitor(req.visitor) })),
);

/** 1) 生成二维码 */
accountsRouter.post(
  '/login',
  guardWrites,
  h(async (req, res) => {
    if (!rateLimit(`login:${req.visitor.id}`, 10, 60_000)) throw tooMany('扫码太频繁，缓一分钟');
    const r = await startLogin(req.visitor);
    res.json(r);
  }),
);

/** 2) 轮询扫码状态（前端 1s 一次；也支持 SSE 订阅） */
accountsRouter.get(
  '/login/:sid',
  h(async (req, res) => {
    const r = await pollLogin(req.visitor, req.params.sid);
    res.json(r);
  }),
);

/** 3) 扫码进度 SSE：服务端替客户端轮询，减少握手 */
accountsRouter.get(
  '/login/:sid/events',
  h(async (req, res) => {
    const { send, close } = openSse(req, res);
    const sid = req.params.sid;
    let stopped = false;
    req.on('close', () => {
      stopped = true;
    });
    const loop = async () => {
      while (!stopped) {
        let r;
        try {
          r = await pollLogin(req.visitor, sid);
        } catch (e) {
          send('error', { message: e.message });
          break;
        }
        send('status', r);
        if (r.status === 'done' || r.status === 'expired') break;
        await new Promise((x) => setTimeout(x, 1200));
      }
      close();
    };
    loop();
  }),
);

accountsRouter.delete(
  '/:id',
  h(async (req, res) => res.json(removeAccount(req.visitor, req.params.id))),
);

/** 手动跑一次；同一个账号已有任务时复用 */
accountsRouter.post(
  '/:id/run',
  guardWrites,
  h(async (req, res) => {
    const account = getOwned(req.visitor, req.params.id);
    const { jobId, reused } = enqueueRun(account, { tasks: req.body?.tasks });
    res.json({ jobId, reused });
  }),
);

accountsRouter.post(
  '/:id/sync',
  guardWrites,
  h(async (req, res) => {
    const account = getOwned(req.visitor, req.params.id);
    res.json(enqueueSync(account));
  }),
);

accountsRouter.put(
  '/:id/schedule',
  guardWrites,
  h(async (req, res) => res.json(setSchedule(req.visitor, req.params.id, req.body || {}))),
);

/** 账号最近日志（首屏用，后续接 SSE） */
accountsRouter.get(
  '/:id/events',
  h(async (req, res) => {
    const account = getOwned(req.visitor, req.params.id);
    res.json({ events: events.recentForAccount(account.id, Number(req.query.limit) || 80) });
  }),
);
