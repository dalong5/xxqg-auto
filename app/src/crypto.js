import crypto from 'node:crypto';
import { config } from './config.js';

// 用户 cookie 等价于账号密码，落盘必须加密（AES-256-GCM）
export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function open(blob) {
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < 29) throw new Error('加密串长度异常');
  const d = crypto.createDecipheriv('aes-256-gcm', config.key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

/** 解密失败返回 null，便于上层做自愈 */
export function tryOpen(blob) {
  try {
    return open(blob);
  } catch {
    return null;
  }
}

export function randomId(n = 16) {
  return crypto.randomBytes(n).toString('hex');
}
