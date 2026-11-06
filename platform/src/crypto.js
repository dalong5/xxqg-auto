import crypto from 'node:crypto';
import { masterKey } from './config.js';

// 密钥只取一次：seal/open 在每次扫码、每个任务里都会调用，重复读文件/哈希是白烧 CPU
let cachedKey = null;
function key() {
  if (!cachedKey) cachedKey = masterKey();
  return cachedKey;
}

/** 账号 cookie 等价于密码：AES-256-GCM 落库，密钥不进 DB */
export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function open(blob) {
  const raw = Buffer.from(blob, 'base64url');
  if (raw.length < 29) throw new Error('加密串长度异常');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

export function tryOpen(blob) {
  try {
    return open(blob);
  } catch {
    return null;
  }
}

/** HMAC 签名 cookie：`id.sig`，防篡改，无需服务端 session 表 */
export function sign(value, secret) {
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsign(signed, secret) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expect = sign(value, secret);
  const a = Buffer.from(signed);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

export const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
