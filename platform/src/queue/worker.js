import os from 'node:os';
import { config, assertConfig } from '../config.js';
import { logger } from '../logger.js';
import { getDb } from '../store/db.js';
import { jobs, workers, events, accounts } from '../store/repo.js';
import { runJob } from '../services/jobs.js';

const WORKER_ID = `${config.workerName}-${process.pid}`;
const log = logger.child({ worker: WORKER_ID });

assertConfig();
getDb();

let running = 0;
let stopping = false;
/** 进程内账号锁：key = account_id；防止超时/重试时同一账号被并发驱动 */
const busy = new Set();

function beat() {
  workers.beat(WORKER_ID, { host: os.hostname(), pid: process.pid, concurrency: config.workerConcurrency });
  const freed = jobs.requeueDead(config.workerStaleMs);
  for (const j of freed) {
    log.warn('requeued dead job', { jobId: j.id, prevWorker: j.worker_id });
    events.add({
      jobId: j.id,
      accountId: j.account_id,
      level: 'warn',
      type: 'job_requeued',
      message: `原执行者 ${j.worker_id || '?'} 已失联，作业重新入队`,
    });
  }
  const leases = accounts.expireLeases();
  if (leases) log.debug('expired account leases', { count: leases });
  workers.prune(config.workerStaleMs);
}

/** 执行一个任务：超时保护 + 事件落库（SSE 的数据源） */
async function exec(job) {
  const ctx = { jobId: job.id, accountId: job.account_id };
  const accountKey = job.account_id || job.id;
  const emit = (e) => {
    if (!e || !e.type) return;
    events.add({
      jobId: job.id,
      accountId: job.account_id,
      level: e.level || 'info',
      type: e.type,
      message: e.message || null,
      payload: e.payload || null,
    });
    if (e.level === 'error') log.error(e.message || e.type, ctx);
    else log.info(e.message || e.type, ctx);
  };

  let timer;
  let settled = false;
  // 超时要「真取消」：abort 之后驱动会自己停下，而不是留一个幽灵任务继续跑
  const ac = new AbortController();
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      ac.abort();
      rej(new Error(`任务超时（${Math.round(config.jobTimeoutMs / 1000)}s）`));
    }, config.jobTimeoutMs);
  });

  const work = (async () => runJob(job, { onEvent: emit, signal: ac.signal }))();
  // 不论超时与否，都等真正的工作收尾后再释放账号（否则重试会和幽灵任务撞车）
  const release = work
    .catch(() => {})
    .finally(() => {
      settled = true;
      clearTimeout(timer);
      busy.delete(accountKey);
      running -= 1;
    });

  try {
    const result = await Promise.race([work, timeout]);
    jobs.finish(job.id, { status: 'done', result });
    emit({ type: 'job_done', message: '作业完成' });
  } catch (err) {
    const aborted = err?.code === 'ABORTED' || ac.signal.aborted;
    const canRetry = !aborted && (job.attempts ?? 0) < (job.max_attempts ?? 2);
    log.error('job failed', { ...ctx, err: err.message, canRetry, aborted });
    events.add({
      jobId: job.id,
      accountId: job.account_id,
      level: 'error',
      type: aborted ? 'job_aborted' : 'job_failed',
      message: err.message,
    });
    if (canRetry) {
      jobs.retry(job.id);
      events.add({ jobId: job.id, accountId: job.account_id, level: 'warn', type: 'retry', message: `将重试（第 ${job.attempts} 次失败）` });
    } else {
      jobs.finish(job.id, { status: 'failed', error: err.message });
      if (/cookie|登录|失效|unauthorized/i.test(err.message)) {
        const acc = accounts.get(job.account_id);
        if (acc) accounts.setStatus(acc.id, 'expired');
      }
    }
  } finally {
    // 释放账号租约（无论成功/失败/超时）
    if (job.account_id) accounts.releaseLease(job.account_id, WORKER_ID);
    if (!settled) {
      // 超时路径：给底层工作 10s 收尾时间，避免下一个任务和它抢同一账号
      await Promise.race([release, sleep(10_000)]);
    }
  }
}

async function loop() {
  beat();
  while (!stopping) {
    if (running >= config.workerConcurrency) {
      await sleep(300);
      continue;
    }
    const job = jobs.claim(WORKER_ID);
    if (!job) {
      await sleep(700);
      continue;
    }
    const accountKey = job.account_id || job.id;
    // 进程内再加一道锁：同一账号上一单还没真正收尾时，不接新单
    if (busy.has(accountKey)) {
      jobs.retry(job.id);
      log.warn('account busy, requeued', { jobId: job.id, accountKey });
      await sleep(500);
      continue;
    }
    // 跨进程租约：抢不到说明别的 worker 正在驱动这个账号，放回队列等下一轮
    if (job.account_id) {
      const got = accounts.acquireLease(job.account_id, WORKER_ID, config.jobTimeoutMs + 60_000);
      if (!got) {
        jobs.retry(job.id);
        log.warn('account leased by another worker, requeued', { jobId: job.id, accountId: job.account_id });
        events.add({
          jobId: job.id,
          accountId: job.account_id,
          level: 'warn',
          type: 'job_leased',
          message: '该账号正在被另一个 worker 处理，稍后重试',
        });
        await sleep(600);
        continue;
      }
    }
    busy.add(accountKey);
    running += 1;
    log.info('claimed job', { jobId: job.id, type: job.type, attempt: job.attempts });
    exec(job);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const beatTimer = setInterval(beat, 20_000);
beatTimer.unref?.();

loop().catch((e) => {
  log.error('worker loop crashed', { err: e.message, stack: e.stack?.split('\n')[2] });
  process.exit(1);
});

function shutdown(sig) {
  log.info('worker stopping', { sig, running });
  stopping = true;
  clearInterval(beatTimer);
  // 等正在跑的任务收尾（最多 10s）
  const t0 = Date.now();
  const wait = setInterval(() => {
    if (running === 0 || Date.now() - t0 > 10_000) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
