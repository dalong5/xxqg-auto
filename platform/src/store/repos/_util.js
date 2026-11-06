import { getDb, now } from '../db.js';

export const d = () => getDb();
export { now };

export const parse = (s, fallback = null) => {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/** JSON 列统一编码：undefined/null 一律存 NULL，避免 'null' 字符串 */
export const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
