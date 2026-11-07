import crypto from 'node:crypto';
import { config } from './config.js';

// 访客会话：HttpOnly + 签名，多人同时用互不串号
const NAME = 'xxqg_v';

function sign(id) {
  return crypto.createHmac('sha256', config.key).update(id).digest('base64url').slice(0, 22);
}

export function readVisitor(req) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(NAME + '='));
  if (!hit) return null;
  let value;
  try { value = decodeURIComponent(hit.slice(NAME.length + 1)); } catch { return null; }
  const [id, mac] = value.split('.');
  if (!id || !mac || sign(id) !== mac) return null;
  return id;
}

export function issueVisitor(res) {
  const id = crypto.randomUUID();
  res.setHeader(
    'set-cookie',
    `${NAME}=${encodeURIComponent(`${id}.${sign(id)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}`,
  );
  return id;
}

export function ensureVisitor(req, res) {
  const existing = readVisitor(req);
  if (existing) return { id: existing, fresh: false };
  return { id: issueVisitor(res), fresh: true };
}

/** 极简内存限流：单实例够用，多实例换 Redis */
const hits = new Map();
const MAX_KEYS = 2000;

/**
 * 限流。注意 key 会随访客/IP 增加，必须清理过期项，
 * 否则进程跑久了这个 Map 只增不减（内存泄漏）。
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);

  if (hits.size > MAX_KEYS) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
    }
    // 极端情况下（全是活跃 key）直接丢最老的一半，保证内存有界
    if (hits.size > MAX_KEYS) {
      let drop = Math.floor(hits.size / 2);
      for (const k of hits.keys()) {
        if (drop-- <= 0) break;
        hits.delete(k);
      }
    }
  }
  return true;
}

/** 测试/运维用：当前限流表大小 */
export const rateLimitSize = () => hits.size;
