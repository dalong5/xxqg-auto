export const TASK_NAMES = Object.freeze({
  login: '每日登录', article: '阅读文章', video: '视听学习', daily: '每日答题',
  weekly: '每周答题', special: '专项答题', sync: '查询积分', selftest: '浏览器自检',
});

export const taskName = value => TASK_NAMES[value] || '学习任务';

export function userError(value) {
  const text = String(value ?? '').split('\n')[0].trim();
  if (/\b429\b|too many requests|rate.?limit/i.test(text)) return '平台提示操作过于频繁，已停止，请稍后在官方应用确认状态';
  if (/\b(?:401|403)\b|unauthorized|forbidden/i.test(text)) return '登录状态失效或平台拒绝访问，已停止，请在官方应用确认账号状态后重新扫码';
  if (/captcha|slider|verify failed|risk|security.?check|访问异常|风控|账号异常/i.test(text)) return '平台要求安全验证或提示账号异常，已停止，请在官方页面检查并人工处理';
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return '操作等待超时，请检查网络和页面状态后重试';
  if (/ECONN|ENOTFOUND|net::|fetch failed|failed to fetch|network/i.test(text)) return '网络连接失败，请检查网络或服务状态后重试';
  if (/target.*closed|browser.*closed|context.*closed/i.test(text)) return '浏览器连接已断开，请重新运行任务';
  const translated = text.replace(/\bcookie\b/gi, '登录状态').replace(/\biframe\b/gi, '授权页面').replace(/\bHTTP\b/g, '服务响应状态');
  if (!translated || /[a-zA-Z]|<[^>]*>/.test(translated)) return '执行遇到异常，已停止，请检查登录状态和页面后重试';
  return translated;
}

export function logText(value) {
  const raw = String(value ?? '');
  if (/\[dbg\]|<\/?(?:div|button|span)\b/i.test(raw) && !raw.includes('失败：')) return '正在检查答题页面状态';
  const metrics = raw.match(/^HTTP (\d+) · iframe (\d+) · sso (true|false) · qr (\d+) · (\d+)ms$/);
  if (metrics) return `登录页面响应状态 ${metrics[1]}，共 ${metrics[2]} 个子页面，${metrics[3] === 'true' ? '授权页面已加载' : '授权页面未加载'}，${Number(metrics[4]) ? '二维码已显示' : '二维码未显示'}，耗时 ${(Number(metrics[5]) / 1000).toFixed(1)} 秒`;
  const text = raw.replace(/\b(login|article|video|daily|weekly|special|sync|selftest)\b/g, taskName);
  const failure = text.indexOf('失败：');
  if (failure >= 0) return text.slice(0, failure + 3) + userError(text.slice(failure + 3));
  if (/locator\.|page\.|browserType\.|Call log:|\bError\b|ECONN|ETIMEDOUT|\bHTTP\b/.test(text)) return userError(text);
  if (!/[\u3400-\u9fff]/.test(text) && /[a-zA-Z]/.test(text)) return userError(text);
  return text;
}
