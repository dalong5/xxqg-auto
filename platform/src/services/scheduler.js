import { accounts, events, jobs, logins, schedules } from '../store/repo.js';
import { enqueueRun } from './jobs.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'scheduler' });

/** 把「HH:MM」换算成下一次触发（含 0~15 分钟抖动，防整点挤爆） */
export function nextRunAt(at, from = Date.now()) {
  const [hh, mm] = String(at).split(':').map(Number);
  const next = new Date(from);
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  next.setTime(next.getTime() + Math.floor(Math.random() * 15 * 60_000));
  return next.getTime();
}

/** 到点的定时 → 入队 → 排下一次；顺带清理过期扫码会话 */
export function tickOnce(now = Date.now()) {
  let fired = 0;
  for (const s of schedules.due(now)) {
    const account = accounts.get(s.account_id);
    if (!account) {
      schedules.remove(s.account_id);
      continue;
    }
    const { jobId, reused } = enqueueRun(account);
    schedules.markRun(s.id, nextRunAt(s.at, now));
    events.add({
      jobId,
      accountId: account.id,
      type: 'scheduled',
      message: `定时触发 ${s.at}（${reused ? '复用进行中任务' : '新入队'}）`,
    });
    log.info('scheduled run', { accountId: account.id, at: s.at, jobId });
    fired += 1;
  }
  const expired = logins.expireStale();
  if (expired) log.debug('expired login sessions', { count: expired });
  return fired;
}

export function startScheduler(intervalMs = 15_000) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      tickOnce();
    } catch (e) {
      log.error('scheduler tick failed', { err: e.message });
    }
  }, intervalMs);
  timer.unref?.();
  try {
    tickOnce();
  } catch (e) {
    log.error('scheduler first tick failed', { err: e.message });
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export { jobs };
