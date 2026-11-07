/**
 * 共享小工具。
 */

/**
 * 安全解析 JSON：数据库里的 payload / 快照可能是半截或旧格式，
 * 直接 JSON.parse 抛错会让整页接口 500，甚至把 SSE 定时器打挂（setInterval 里抛错 = 进程退出）。
 */
export function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const TRANSIENT = /ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|timeout/i;

/**
 * 只对「网络类瞬时错误」重试，业务错误（401、二维码过期等）立即抛出。
 * 扫码轮询一次抖动就把整个登录判失败，用户得重新扫码，体验很差。
 */
export async function retryTransient(fn, { tries = 3, delayMs = 800, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!TRANSIENT.test(String(e?.message || e))) throw e;
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  throw lastError;
}
