import { config } from './config.js';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { taskName, logText, userError } from './messages.js';
import { parseJson } from './util.js';
import * as db from './db.js';
import { Jar, score } from './xxqg/client.js';
import { learn, quiz } from './xxqg/tasks.js';
import { newSession, closeBrowser, getBrowser } from './xxqg/browser.js';
import { claimLogin, driveLogin } from './loginflow.js';
import { open as unseal, seal } from './crypto.js';

const WORKER_ID = `${process.env.WORKER_NAME || 'w'}-${process.pid}-${randomUUID()}`;
const TASK_KINDS = ['run', 'sync', 'selftest'];

const log = (job, text, type = 'log') => db.addEvent(job.id, job.uid, type, { text: logText(text) });

const tryUnseal = (blob) => {
  try {
    return unseal(blob);
  } catch {
    return null;
  }
};

/**
 * 风控/登录失效判定：这类错误继续跑别的任务只会加重风险，必须立刻停。
 * 普通任务失败（积分没达标、页面异常）则允许继续后面的任务。
 */
const SAFETY_STOP =
  /\b(?:401|403|429)\b|captcha|slider|risk|security.?check|too many requests|rate.?limit|unauthorized|forbidden|验证|风控|账号异常|访问异常|登录.*失效|cookie.*失效|请求被拒绝/i;
const isSafetyStop = (message) => SAFETY_STOP.test(String(message || ''));

/**
 * 取账号 cookie。解密失败时从最近的登录会话恢复并重新加密。
 * 这样换过 APP_SECRET、密钥文件被覆盖之后，用户不用重扫码。
 */
function jobUser(job) {
  const user = db.getUser(job.uid);
  if (!user) throw new Error('用户不存在');
  if ((job.visitor_id && job.visitor_id !== user.visitor_id) || (job.loginGeneration !== undefined && job.loginGeneration !== user.login_generation)) {
    throw new Error('账号登录或归属已更新，旧任务已停止，请重新发起任务');
  }
  if (db.getJob(job.id)?.status === 'pausing') {
    const error = new Error('任务已暂停');
    error.code = 'TASK_PAUSED';
    throw error;
  }
  job.loginGeneration = user.login_generation;
  return user;
}

function userJar(job) {
  const user = jobUser(job);
  const opened = tryUnseal(user.sealed_cookie);
  if (opened) return new Jar(opened);

  const backup = db.db
    .prepare("SELECT jar FROM logins WHERE uid = ? AND status = 'done' AND jar IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    .get(job.uid);
  if (!backup?.jar) throw new Error('cookie 无法解密，请重新扫码');
  const jar = new Jar(JSON.parse(backup.jar));
  db.db.prepare('UPDATE users SET sealed_cookie = ? WHERE uid = ?').run(seal(jar.toJSON()), job.uid);
  console.warn(`[repair] ${job.uid} 的 cookie 解密失败，已从登录会话恢复`);
  return jar;
}

const patchScore = async (job) => {
  if (!job.uid) return null;
  const s = await score(userJar(job));
  jobUser(job);
  if (s) db.setUserScore(job.uid, s);
  return s;
};

const HANDLERS = {
  /** 只查积分，不启浏览器，最便宜 */
  async sync(job) {
    const s = await patchScore(job);
    if (!s) throw new Error('cookie 已失效');
    db.addEvent(job.id, job.uid, 'score', s);
  },

  /** 自检：不登录也能跑，用来验证浏览器与网络是否正常 */
  async selftest(job) {
    const started = Date.now();
    const { page, ctx } = await newSession(new Jar());
    try {
      const res = await page.goto('https://pc.xuexi.cn/points/login.html', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      // 登录页是 SPA：先等授权 iframe 出现，再等它把二维码画出来
      let sso = null;
      for (let i = 0; i < 50 && !sso; i++) {
        sso = page.frames().find((f) => f.url().includes('/login/xuexiWeb')) || null;
        if (!sso) await page.waitForTimeout(500);
      }
      let qrPixels = 0;
      if (sso) {
        for (let i = 0; i < 40 && !qrPixels; i++) {
          qrPixels = await sso
            .locator('img, canvas')
            .count()
            .catch(() => 0);
          if (!qrPixels) await page.waitForTimeout(500);
        }
      }
      const frames = page.frames().map((f) => f.url());
      log(job, `HTTP ${res?.status()} · iframe ${frames.length} · sso ${Boolean(sso)} · qr ${qrPixels} · ${Date.now() - started}ms`);
      if (!qrPixels) throw new Error('登录页面未完整加载，二维码或授权页面缺失');
    } finally {
      await ctx.close().catch(() => {});
    }
  },

  /** 正式任务 */
  async run(job) {
    const tasks = parseJson(job.tasks, []);
    const jar = userJar(job);

    const state = { tasks: {} };
    // tasks.js 的约定：progress() 取当前进度，progress.note 写日志，progress.refresh 现查一次，
    // shouldStop 单独传
    const progress = Object.assign(() => ({ tasks: state.tasks }), { note: (text) => log(job, text) });
    const opts = {
      jar,
      uid: job.uid,
      jobId: job.id,
      progress,
      shouldStop: () => {
        jobUser(job);
        return Date.now() - (job.started_at || job.created_at) > config.taskBudgetMs;
      },
      refresh: async () => {
        jobUser(job);
        const s = await score(jar);
        jobUser(job);
        if (s) {
          state.tasks = s.tasks;
          db.setUserScore(job.uid, s);
          db.addEvent(job.id, job.uid, 'score', s);
        }
        return s;
      },
    };
    progress.refresh = async () => {
      const s = await opts.refresh();
      if (!s) throw new Error('积分回查失败，停止任务，请检查登录状态');
      return s;
    };

    const current = await score(jar);
    jobUser(job);
    if (!current) throw new Error('cookie 已失效，请重新扫码');
    state.tasks = current.tasks;
    db.setUserScore(job.uid, current);
    db.addEvent(job.id, job.uid, 'score', current);

    const runners = {
      login: async () => {
        const { page, close } = await newSession(jar, { uid: job.uid, jobId: job.id, shouldStop: opts.shouldStop });
        try {
          await page.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(6000);
          const s = await progress.refresh();
          const t = s.tasks?.[9];
          if (!t || t.done < t.max) throw new Error('登录签到积分未确认');
          return '登录签到积分已确认';
        } finally {
          await close();
        }
      },
      article: () => learn('article', opts),
      video: () => learn('video', opts),
      daily: () => quiz('daily', opts),
      weekly: () => quiz('weekly', opts),
      special: () => quiz('special', opts),
    };

    // 单个任务失败不应拖垮整轮：普通失败记下来继续跑下一项，
    // 只有风控/登录失效这类继续下去也没意义的错误才立刻中止。
    const failures = [];
    let succeeded = 0;

    for (const name of tasks) {
      if (opts.shouldStop()) {
        throw new Error('超出时长预算，任务尚未完成');
      }
      if (!runners[name]) continue;
      log(job, `▶ 开始 ${taskName(name)}`, 'step');
      try {
        const msg = await runners[name]();
        log(job, `✔ ${taskName(name)}：${msg}`, 'ok');
        succeeded++;
      } catch (e) {
        if (e.code === 'TASK_PAUSED') throw e;
        const reason = userError(e.message || e);
        log(job, `✘ ${taskName(name)} 失败：${reason}`, 'bad');
        // 风控/登录失效：继续跑别的只会加重风险，立即停
        if (isSafetyStop(String(e.message || e))) throw e;
        failures.push(`${taskName(name)}：${reason}`);
        continue;
      }
      const latest = await score(jar);
      jobUser(job);
      if (latest) {
        state.tasks = latest.tasks;
        db.setUserScore(job.uid, latest);
        db.addEvent(job.id, job.uid, 'score', latest);
      } else {
        throw new Error('登录态失效，任务尚未完成');
      }
      // 任务之间歇一会儿，别像脚本一样连着冲
      if (name !== tasks.at(-1)) {
        const until = Date.now() + 15000 + Math.floor(Math.random() * 30000);
        while (Date.now() < until) { jobUser(job); await pause(Math.min(1000, until - Date.now())); }
      }
    }

    const final = await patchScore(job);
    if (!final) throw new Error('最终积分回查失败，未确认任务完成');
    if (succeeded === 0 && failures.length) throw new Error(`全部任务未完成：${failures.join('；')}`);
    if (failures.length) log(job, `⚠ 部分任务未完成，其余已完成：${failures.join('；')}`, 'bad');
    db.addEvent(job.id, job.uid, 'done', final);
  },
};

async function runTaskJob(job) {
  // 数据库里的 tasks 可能是空、旧格式或半截 JSON，解析失败就退回单任务
  const parsed = parseJson(job.tasks, null);
  const tasks = Array.isArray(parsed) && parsed.length ? parsed : [job.kind];
  db.addEvent(job.id, job.uid, 'start', { tasks });
  // 同时打到 stdout：docker logs 能直接看到任务起止，运维不用翻数据库
  const startedAt = Date.now();
  console.log('[job] 开始 %s %s (%s)', job.id.slice(0, 8), tasks.join('+'), job.uid || '-');
  const error = db.scheduledJobError(job);
  if (error) {
    db.failJob(job.id, error);
    db.addEvent(job.id, job.uid, 'error', { error });
    console.log('[job] 拒绝 %s: %s', job.id.slice(0, 8), error);
    return;
  }
  try {
    await HANDLERS[job.kind](job);
    if (db.finishJob(job.id)?.status === 'paused') log(job, '任务已暂停，可点击继续任务');
    console.log('[job] 完成 %s 用时 %ss', job.id.slice(0, 8), Math.round((Date.now() - startedAt) / 1000));
  } catch (e) {
    if (e.code === 'TASK_PAUSED') {
      if (db.finishPausedJob(job.id)?.status === 'paused') log(job, '任务已暂停，可点击继续任务');
      console.log('[job] 暂停 %s', job.id.slice(0, 8));
      return;
    }
    const message = String(e.message || e);
    const safetyStop = isSafetyStop(message);
    // 登录彻底失效（401/cookie 失效）时给账号打标记，界面上提示重新扫码，避免反复空跑
    if (/\b401\b|登录.*失效|cookie.*失效|unauthorized/i.test(message) && job.uid) {
      db.markNeedsRescan(job.uid);
      console.log('[job] 账号 %s 登录失效，已标记需要重新扫码', job.uid);
    }
    const retry = !safetyStop && db.getJob(job.id)?.status !== 'pausing' && job.attempts < 2 && /ECONN|timeout|ETIMEDOUT/i.test(message);
    db.failJob(job.id, e.message || e, retry);
    db.addEvent(job.id, job.uid, 'error', { error: userError(e.message || e) });
    console.log('[job] 失败 %s %s%s', job.id.slice(0, 8), userError(message), retry ? '（稍后重试）' : '');
  } finally {
    // 任务结束（成功/失败/暂停）都清掉遗留的转发动作，避免表里攒垃圾
    db.clearVerificationActions(job.id);
  }
}

// ---------------- 调度 ----------------
let taskRunning = 0;
let loginRunning = 0;
let stopping = false;

/**
 * 空闲释放浏览器：一个 Chromium 常驻约 150–250MB，而任务是一阵一阵来的。
 * 空闲超过 BROWSER_IDLE_CLOSE_MS 就关掉，下一个任务来了再懒启动。
 */
const IDLE_CLOSE_MS = Number(process.env.BROWSER_IDLE_CLOSE_MS ?? 120_000);
let lastJobAt = Date.now();
let browserClosed = false;

async function closeIfIdle() {
  if (browserClosed) return;
  if (taskRunning > 0 || loginRunning > 0) return;
  if (Date.now() - lastJobAt < IDLE_CLOSE_MS) return;
  browserClosed = true;
  await closeBrowser().catch(() => {});
  console.log(`[mem] 空闲 ${Math.round(IDLE_CLOSE_MS / 1000)}s，已释放浏览器`);
}


/**
 * 内存保护：并发名额可以开得比内存大，但不能把机器拖进 swap 抖动。
 * 已经在跑任务、且可用内存低于阈值时，暂缓领取新任务（不中断已在跑的）。
 * /proc/meminfo 在容器里通常反映宿主机内存，正好是我们想保护的量。
 */
const MIN_FREE_MB = Number(process.env.WORKER_MIN_FREE_MB ?? 200);
let memGateLogged = 0;

function availableMemMb() {
  if (process.platform !== 'linux') return Infinity;
  try {
    const m = /MemAvailable:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : Infinity;
  } catch {
    return Infinity;
  }
}

async function taskLoop() {
  while (!stopping) {
    if (taskRunning >= config.workerConcurrency) {
      await pause(400);
      continue;
    }
    // 留一个任务在上面跑着，不让整机空闲；再多的名额要看内存
    if (taskRunning > 0 || taskRunning >= 1) {
      const free = availableMemMb();
      if (free < MIN_FREE_MB) {
        const now = Date.now();
        if (now - memGateLogged > 60_000) {
          console.warn(`[mem] 可用内存 ${free}MB < ${MIN_FREE_MB}MB，暂缓领取新任务`);
          memGateLogged = now;
        }
        await pause(3000);
        continue;
      }
    }
    let job = null;
    for (const kind of TASK_KINDS) {
      job = db.claimJob(kind, WORKER_ID);
      if (job) break;
    }
    if (!job) {
      await closeIfIdle();
      await pause(700);
      continue;
    }
    lastJobAt = Date.now();
    browserClosed = false;
    taskRunning++;
    runTaskJob(job)
      .catch((e) => console.error('job crash', e))
      .finally(() => taskRunning--);
  }
}

async function loginLoop() {
  while (!stopping) {
    if (loginRunning >= config.loginConcurrency) {
      await pause(200);
      continue;
    }
    const row = claimLogin();
    if (!row) {
      await closeIfIdle();
      await pause(400);
      continue;
    }
    lastJobAt = Date.now();
    browserClosed = false;
    loginRunning++;
    driveLogin(row.sid)
      .catch((e) => console.error('login crash', e))
      .finally(() => loginRunning--);
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startWorker() {
  // 先注册心跳再回收，否则会把自己刚领的任务当成死任务
  db.beat(WORKER_ID);
  await getBrowser().catch((e) => console.error('浏览器启动失败:', e.message));
  db.requeueDeadJobs();
  db.deleteStaleLogins();
  console.log(
    `worker ${WORKER_ID} 就绪：任务并发 ${config.workerConcurrency}，登录并发 ${config.loginConcurrency} key=${config.keyFingerprint}`,
  );
  taskLoop();
  loginLoop();

  setInterval(() => {
    db.beat(WORKER_ID);
    db.requeueDeadJobs();
    db.trimEvents();
    db.deleteStaleLogins();
  }, 20_000).unref?.();

  setInterval(() => {
    db.addEvent(null, null, 'heartbeat', { worker: WORKER_ID, at: Date.now() });
  }, 30_000).unref?.();
}

export function stopWorker() {
  stopping = true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      stopWorker();
      await closeBrowser();
      process.exit(0);
    });
  }
}
