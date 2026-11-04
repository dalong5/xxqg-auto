import { config } from './config.js';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as db from './db.js';
import { Jar, score } from './xxqg/client.js';
import { learn, quiz } from './xxqg/tasks.js';
import { newSession, closeBrowser, getBrowser } from './xxqg/browser.js';
import { claimLogin, driveLogin } from './loginflow.js';
import { open as unseal, seal } from './crypto.js';

const WORKER_ID = `${process.env.WORKER_NAME || 'w'}-${process.pid}-${randomUUID()}`;
const TASK_KINDS = ['run', 'sync', 'selftest'];

const log = (job, text, type = 'log') => db.addEvent(job.id, job.uid, type, { text });

const tryUnseal = (blob) => {
  try {
    return unseal(blob);
  } catch {
    return null;
  }
};

/**
 * 取账号 cookie。解密失败时从最近的登录会话恢复并重新加密。
 * 这样换过 APP_SECRET、密钥文件被覆盖之后，用户不用重扫码。
 */
function userJar(uid) {
  const user = db.getUser(uid);
  if (!user) throw new Error('用户不存在');
  const opened = tryUnseal(user.sealed_cookie);
  if (opened) return new Jar(opened);

  const backup = db.db
    .prepare("SELECT jar FROM logins WHERE uid = ? AND status = 'done' AND jar IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    .get(uid);
  if (!backup?.jar) throw new Error('cookie 无法解密，请重新扫码');
  const jar = new Jar(JSON.parse(backup.jar));
  db.db.prepare('UPDATE users SET sealed_cookie = ? WHERE uid = ?').run(seal(jar.toJSON()), uid);
  console.warn(`[repair] ${uid} 的 cookie 解密失败，已从登录会话恢复`);
  return jar;
}

const patchScore = async (job) => {
  if (!job.uid) return null;
  const s = await score(userJar(job.uid)).catch(() => null);
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
      db.addEvent(job.id, null, 'log', {
        text: `HTTP ${res?.status()} · iframe ${frames.length} · sso ${Boolean(sso)} · qr ${qrPixels} · ${Date.now() - started}ms`,
      });
      if (!qrPixels) throw new Error('登录流程未完整渲染（二维码或授权 iframe 缺失）');
    } finally {
      await ctx.close().catch(() => {});
    }
  },

  /** 正式任务 */
  async run(job) {
    const tasks = JSON.parse(job.tasks || '[]');
    const jar = userJar(job.uid);

    const state = { tasks: {} };
    // tasks.js 的约定：progress() 取当前进度，progress.note 写日志，progress.refresh 现查一次，
    // shouldStop 单独传
    const progress = Object.assign(() => ({ tasks: state.tasks }), { note: (text) => log(job, text) });
    const opts = {
      jar,
      uid: job.uid,
      jobId: job.id,
      progress,
      shouldStop: () => Date.now() - (job.started_at || job.created_at) > config.taskBudgetMs,
      refresh: async () => {
        const s = await score(jar).catch(() => null);
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

    const current = await score(jar).catch(() => null);
    if (!current) throw new Error('cookie 已失效，请重新扫码');
    state.tasks = current.tasks;
    db.setUserScore(job.uid, current);
    db.addEvent(job.id, job.uid, 'score', current);

    const runners = {
      login: async () => {
        const { page, close } = await newSession(jar, { uid: job.uid, jobId: job.id });
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

    for (const name of tasks) {
      if (opts.shouldStop()) {
        throw new Error('超出时长预算，任务尚未完成');
      }
      if (!runners[name]) continue;
      log(job, `▶ 开始 ${name}`, 'step');
      try {
        const msg = await runners[name]();
        log(job, `✔ ${name}：${msg}`, 'ok');
      } catch (e) {
        log(job, `✘ ${name} 失败：${e.message || e}`, 'bad');
        throw e;
      }
      const latest = await score(jar).catch(() => null);
      if (latest) {
        state.tasks = latest.tasks;
        db.setUserScore(job.uid, latest);
        db.addEvent(job.id, job.uid, 'score', latest);
      } else {
        throw new Error('登录态失效，任务尚未完成');
      }
      // 任务之间歇一会儿，别像脚本一样连着冲
      if (name !== tasks.at(-1)) await new Promise((r) => setTimeout(r, 15000 + Math.floor(Math.random() * 30000)));
    }

    const final = await patchScore(job);
    if (!final) throw new Error('最终积分回查失败，未确认任务完成');
    db.addEvent(job.id, job.uid, 'done', final);
  },
};

async function runTaskJob(job) {
  db.addEvent(job.id, job.uid, 'start', { tasks: job.tasks ? JSON.parse(job.tasks) : [job.kind] });
  try {
    await HANDLERS[job.kind](job);
    db.finishJob(job.id);
  } catch (e) {
    const retry = job.attempts < 2 && /ECONN|timeout|ETIMEDOUT/i.test(String(e.message));
    db.failJob(job.id, e.message || e, retry);
    db.addEvent(job.id, job.uid, 'error', { error: String(e.message || e) });
  }
}

// ---------------- 调度 ----------------
let taskRunning = 0;
let loginRunning = 0;
let stopping = false;

async function taskLoop() {
  while (!stopping) {
    if (taskRunning >= config.workerConcurrency) {
      await pause(400);
      continue;
    }
    let job = null;
    for (const kind of TASK_KINDS) {
      job = db.claimJob(kind, WORKER_ID);
      if (job) break;
    }
    if (!job) {
      await pause(700);
      continue;
    }
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
      await pause(400);
      continue;
    }
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
