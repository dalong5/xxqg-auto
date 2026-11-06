/** 任务清单与归一化：唯一真相，服务和路由都从这里取 */
export const TASK_KINDS = ['login', 'article', 'video', 'daily', 'weekly', 'special'];

export const TASK_LABEL = {
  login: '每日登录',
  article: '阅读文章',
  video: '视听学习',
  daily: '每日答题',
  weekly: '每周答题',
  special: '专项答题',
};

const TASK_SET = new Set(TASK_KINDS);

/**
 * 把外部传入的 tasks 归一化成合法的有序数组。
 * 空/非法 → 全套；未知项直接丢弃（不报错，保持向后兼容）。
 */
export function normalizeTasks(raw) {
  const list = Array.isArray(raw) && raw.length ? raw : TASK_KINDS;
  const out = [];
  for (const t of list) {
    const k = String(t || '').trim();
    if (TASK_SET.has(k) && !out.includes(k)) out.push(k);
  }
  return out.length ? out : [...TASK_KINDS];
}
