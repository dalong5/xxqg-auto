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
