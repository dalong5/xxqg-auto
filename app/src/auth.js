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
  const [id, mac] = decodeURIComponent(hit.slice(NAME.length + 1)).split('.');
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
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  return true;
}
