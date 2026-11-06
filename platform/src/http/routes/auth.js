import { Router } from 'express';
import { config } from '../../config.js';
import { visitors, audit } from '../../store/repo.js';
import { setVisitorCookie, clearVisitorCookie, needApproved } from '../../services/session.js';
import { listForVisitor } from '../../services/accounts.js';
import { h } from '../middleware.js';
import { badRequest, forbidden } from '../../errors.js';
import { driverName, getDriver } from '../../domain/index.js';

export const authRouter = Router();

/** 当前身份：未注册也能看，前端据此决定显示邀请码输入还是工作台 */
authRouter.get(
  '/me',
  h(async (req, res) => {
    const v = req.visitor;
    const list = v ? listForVisitor(v) : [];
    res.json({
      visitor: { id: v?.id, approved: !config.inviteCode || !!v?.approved, maxAccounts: v?.max_accounts ?? 1 },
      needInvite: !!config.inviteCode && !v?.approved,
      driver: driverName(),
      accounts: list,
      quota: { used: list.length, max: v?.max_accounts ?? 1 },
    });
  }),
);

/** 用邀请码注册/放行 */
authRouter.post(
  '/register',
  h(async (req, res) => {
    const code = String(req.body?.invite || '').trim();
    if (!config.inviteCode) return res.json({ ok: true, approved: true });
    if (!code) throw badRequest('请填写邀请码');
    if (code !== config.inviteCode) {
      audit.add({ actor: req.visitor?.id, action: 'register.denied', meta: { code } });
      throw forbidden('邀请码不对');
    }
    const v = visitors.approve(req.visitor.id, true);
    setVisitorCookie(res, v.id);
    audit.add({ actor: v.id, action: 'register.approved' });
    res.json({ ok: true, approved: true, maxAccounts: v.max_accounts });
  }),
);

authRouter.post(
  '/logout',
  h(async (_req, res) => {
    clearVisitorCookie(res);
    res.json({ ok: true });
  }),
);

/** 健康检查用的驱动自检（真实站点会打一次上游请求） */
authRouter.get(
  '/selftest',
  needApproved,
  h(async (_req, res) => {
    const d = await getDriver();
    res.json({ ok: true, driver: d.name, at: Date.now() });
  }),
);
