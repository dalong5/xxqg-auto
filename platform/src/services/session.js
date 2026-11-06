import { config } from '../config.js';
import { sign, unsign } from '../crypto.js';
import { visitors } from '../store/repo.js';
import { unauthorized, forbidden, tooMany } from '../errors.js';

/** 简易内存限流：单进程够 MVP；扩容换 Redis 时保持函数签名 */
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || t > b.reset) {
    buckets.set(key, { n: 1, reset: t + windowMs });
    return true;
  }
  b.n += 1;
  if (b.n > limit) return false;
  return true;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of buckets) if (t > v.reset) buckets.delete(k);
}, 60_000).unref?.();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function readVisitor(req) {
  const raw = parseCookies(req.headers.cookie || '')[config.sessionCookie];
  if (!raw) return null;
  const id = unsign(raw, config.secret || 'dev-secret-please-set-32-chars-min');
  if (!id) return null;
  return visitors.get(id);
}

export function setVisitorCookie(res, id) {
  const value = sign(id, config.secret || 'dev-secret-please-set-32-chars-min');
  const parts = [
    `${config.sessionCookie}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
  ];
  if (config.isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearVisitorCookie(res) {
  res.setHeader('Set-Cookie', `${config.sessionCookie}=; Path=/; HttpOnly; Max-Age=0`);
}

/**
 * 认证中间件：没有访客就建一个（匿名可浏览），写操作要求 approved。
 * 邀请码模式下：注册接口校验码，未持码的访客 approved=0。
 */
export function attachVisitor(req, res, next) {
  const v = readVisitor(req);
  if (v) {
    req.visitor = v;
    visitors.touch(v.id);
    return next();
  }
  const created = visitors.create({ approved: config.inviteCode ? 0 : 1, maxAccounts: config.defaultMaxAccounts });
  req.visitor = created;
  req.freshVisitor = true;
  // 关键：新访客必须立刻下发签名 cookie，否则每个请求都会变成新访客
  setVisitorCookie(res, created.id);
  next();
}

export function needApproved(req, _res, next) {
  if (!req.visitor) return next(unauthorized());
  if (config.inviteCode && !req.visitor.approved) return next(forbidden('需要邀请码'));
  next();
}

export function guardWrites(req, _res, next) {
  if (!rateLimit(`w:${req.visitor?.id || req.ip}`, 30, 60_000)) return next(tooMany('操作太频繁，缓一分钟'));
  next();
}
