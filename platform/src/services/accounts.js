import { config } from '../config.js';
import { accounts, logins, schedules, audit } from '../store/repo.js';
import { seal, tryOpen } from '../crypto.js';
import { getDriver } from '../domain/index.js';
import { badRequest, conflict, forbidden, notFound, upstream } from '../errors.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'accounts' });

/** 开始扫码：建登录会话 + 让驱动生成二维码 */
export async function startLogin(visitor) {
  const quota = visitor.max_accounts ?? 1;
  const used = accounts.listByVisitor(visitor.id).length;
  if (used >= quota) throw badRequest(`最多绑定 ${quota} 个账号`);
  const driver = await getDriver();
  const { ref, qr } = await driver.createQr();
  const s = logins.create({ visitorId: visitor.id, platform: driver.name, qr: ref, ttlMs: config.loginTtlMs });
  audit.add({ actor: visitor.id, action: 'login.start', target: s.sid });
  return { sid: s.sid, qr, ttlMs: config.loginTtlMs };
}

/** 轮询扫码结果：完成时落库账号（cookie 密封存储） */
export async function pollLogin(visitor, sid) {
  const s = logins.get(sid);
  if (!s) throw notFound('登录会话不存在');
  if (s.visitor_id !== visitor.id) throw forbidden();
  if (s.status === 'done') return { status: 'done', accountId: s.account_id };
  if (s.status === 'expired') return { status: 'expired' };
  if (Date.now() > s.expires_at) {
    logins.update(sid, { status: 'expired' });
    return { status: 'expired' };
  }

  const driver = await getDriver();
  const r = await driver.pollQr(s.qr).catch((e) => ({ status: 'waiting', error: e.message }));
  if (r.status === 'scanned') {
    logins.update(sid, { status: 'scanned' });
    return { status: 'scanned' };
  }
  if (r.status !== 'done') return { status: r.status || 'waiting' };

  if (!r.uid || !r.cookie) throw upstream('扫码结果缺少 uid/cookie');

  // 并发安全：双开页面 / SSE 与轮询同时回调时，ensure() 靠唯一约束幂等，不会插出第二个账号
  const existing = accounts.byUid(visitor.id, String(r.uid), driver.name);
  if (!existing) {
    const quota = visitor.max_accounts ?? 1;
    if (accounts.listByVisitor(visitor.id).length >= quota) throw conflict(`最多绑定 ${quota} 个账号`);
  }
  const account = accounts.ensure({
    visitorId: visitor.id,
    uid: String(r.uid),
    nick: r.nick,
    cookieEnc: seal(r.cookie),
    platform: driver.name,
  });
  if (!account) throw conflict('账号绑定失败，请重试');
  logins.update(sid, { status: 'done', account_id: account.id });
  audit.add({ actor: visitor.id, action: 'login.done', target: account.id, meta: { uid: account.uid } });
  log.info('account bound', { accountId: account.id, uid: account.uid });
  return { status: 'done', accountId: account.id };
}

export function cookieOf(account) {
  const c = tryOpen(account.cookie_enc);
  if (!c) {
    accounts.setStatus(account.id, 'expired');
    throw new Error('账号 cookie 解不开（密钥变更？），请重新扫码');
  }
  return c;
}

export function listForVisitor(visitor) {
  // 一条 SQL 带出定时信息（原实现是每个账号再查一次 schedules，N+1）
  return accounts.listWithSchedule(visitor.id);
}

export function getOwned(visitor, accountId) {
  const a = accounts.get(accountId);
  if (!a || a.visitor_id !== visitor.id || a.status === 'disabled') throw notFound('账号不存在');
  return a;
}

export function removeAccount(visitor, accountId) {
  const a = getOwned(visitor, accountId);
  accounts.remove(a.id);
  audit.add({ actor: visitor.id, action: 'account.remove', target: a.id });
  return { ok: true };
}

export function setSchedule(visitor, accountId, { at, enabled = true } = {}) {
  const a = getOwned(visitor, accountId);
  if (!enabled || !at) {
    schedules.remove(a.id);
    return { ok: true, schedule: null };
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  if (!m) throw badRequest('时间格式应为 HH:MM');
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw badRequest('时间超出范围');
  const next = new Date();
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  const row = schedules.upsert({ accountId: a.id, visitorId: a.visitor_id, at: `${String(hh).padStart(2, '0')}:${m[2]}`, nextRunAt: next.getTime() });
  audit.add({ actor: visitor.id, action: 'schedule.set', target: a.id, meta: { at: row.at } });
  return { ok: true, schedule: { at: row.at, nextRunAt: row.next_run_at } };
}
