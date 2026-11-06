import { accounts, events, jobs } from '../store/repo.js';
import { getDriver, normalizeTasks } from '../domain/index.js';
import { cookieOf } from './accounts.js';
import { logger } from '../logger.js';
import { AppError } from '../errors.js';

const log = logger.child({ module: 'jobs' });

/**
 * 入队一次「跑全套任务」。
 * 幂等由数据库层保证（部分唯一索引 uq_jobs_active_run）：
 * 同一账号已有排队/运行中的 run 时，INSERT OR IGNORE 不会插入第二条，直接复用。
 */
export function enqueueRun(account, { tasks } = {}) {
  const { id, reused } = jobs.enqueueRunOnce({
    visitorId: account.visitor_id,
    accountId: account.id,
    payload: { tasks: normalizeTasks(tasks) },
  });
  if (!id) {
    // 理论上不会发生：唯一索引挡住了插入却查不到已有行（被并发取消）
    throw new AppError('conflict', '该账号已有进行中的任务，请稍后重试', 409);
  }
  if (!reused) events.add({ jobId: id, accountId: account.id, type: 'queued', message: '任务已入队' });
  return { jobId: id, reused };
}

export function enqueueSync(account) {
  const id = jobs.enqueue({ type: 'sync', visitorId: account.visitor_id, accountId: account.id });
  return { jobId: id };
}

/** worker 侧：执行一个 job。事件通过 onEvent 回调，落库由调用方决定（便于测试） */
export async function runJob(job, { onEvent, signal } = {}) {
  const driver = await getDriver();
  const emit = (e) => onEvent?.(e);
  const aborted = () => signal?.aborted === true;

  if (job.type === 'sync') {
    const account = accounts.get(job.account_id);
    if (!account) throw new AppError('not_found', '账号已删除', 404);
    if (aborted()) throw new AppError('aborted', '任务已取消', 499);
    const score = await driver.fetchScore(cookieOf(account));
    accounts.saveScore(account.id, score);
    emit({ level: 'info', type: 'score', message: `分数同步：今日 ${score.today ?? 0} 分`, payload: score });
    return { score };
  }

  if (job.type !== 'run') throw new AppError('bad_request', `未知任务类型 ${job.type}`, 400);

  const account = accounts.get(job.account_id);
  if (!account) throw new AppError('not_found', '账号已删除', 404);
  const payload = job.payload ? JSON.parse(job.payload) : {};
  const tasks = normalizeTasks(payload.tasks);

  emit({ level: 'info', type: 'start', message: `账号 ${account.nick || account.uid} 开始执行：${tasks.join(' / ')}` });
  const result = await driver.runTasks({
    cookie: cookieOf(account),
    uid: account.uid,
    tasks,
    signal,
    onEvent: emit,
  });

  if (result?.score) accounts.saveScore(account.id, result.score);
  const failed = (result?.results || []).filter((r) => r.status === 'failed');
  emit({
    level: failed.length ? 'warn' : 'info',
    type: 'finished',
    message: failed.length ? `结束，${failed.length} 项失败` : '全部任务结束',
    payload: result,
  });
  if (failed.length) log.warn('job finished with failures', { jobId: job.id, failed: failed.length });
  return result;
}
