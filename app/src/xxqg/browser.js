import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import * as db from '../db.js';

const pageJobs = new WeakMap();

let browser = null;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--mute-audio',
  '--disable-features=RendererCodeIntegrity,IsolateOrigins,site-per-process',
];

export async function getBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({
    // 本机有 Chrome 用 Chrome，容器里用 CHROME_PATH 指向 chromium
    channel: config.chromePath ? undefined : process.env.CHROME_CHANNEL || 'chrome',
    executablePath: config.chromePath || undefined,
    headless: true,
    args: LAUNCH_ARGS,
  });
  browser.on('disconnected', () => {
    browser = null;
  });
  return browser;
}

export async function closeBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
}

// 抹掉自动化痕迹：webdriver、空 plugins、chrome 对象、WebGL 厂商
const STEALTH = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
    ],
  });
  if (!window.chrome) window.chrome = { runtime: {} };
  const patch = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return 'Google Inc. (Intel)';
      if (p === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.5)';
      return orig.call(this, p);
    };
  };
  patch(window.WebGLRenderingContext?.prototype);
  patch(window.WebGL2RenderingContext?.prototype);
  // 权限查询在 headless 下会返回 denied，伪装成正常浏览器
  const query = window.navigator.permissions?.query?.bind(navigator.permissions);
  if (query) {
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : query(p);
  }
};

const profileFile = (uid) => path.join(config.dataDir, 'profiles', `${uid || 'anon'}.json`);

function loadProfile(uid) {
  try {
    return JSON.parse(fs.readFileSync(profileFile(uid), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 开一个会话。同一个账号复用上次的 localStorage/设备态，避免每次都是"新设备"。
 * 调用方负责 close()。
 */
export async function newSession(jar, { uid, jobId } = {}) {
  const b = await getBrowser();
  const state = uid ? loadProfile(uid) : undefined;
  const ctx = await b.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440 + Math.floor(Math.random() * 60), height: 900 },
    deviceScaleFactor: 1,
    extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    storageState: state,
  });
  await ctx.addInitScript(STEALTH);
  if (jar) await ctx.addCookies(jar.toPlaywrightCookies());
  const page = await ctx.newPage();
  if (jobId) pageJobs.set(page, { jobId, uid });

  const close = async () => {
    if (uid) {
      await ctx
        .storageState()
        .then((s) => {
          fs.mkdirSync(path.dirname(profileFile(uid)), { recursive: true });
          fs.writeFileSync(profileFile(uid), JSON.stringify(s));
        })
        .catch(() => {});
    }
    await ctx.close().catch(() => {});
  };
  return { ctx, page, close };
}

/** 随机停顿，模拟人；太快容易被判机器 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (base, spread = 4000) => base + Math.floor(Math.random() * spread);

const CAPTCHA_DIALOG = '#JS_aliyun-captcha-dialog.show';

/** 验证码由用户在网站上的实时画面中操作，执行器只转发用户输入。 */
export async function clearCaptcha(page) {
  if (!(await page.locator(CAPTCHA_DIALOG).count())) return true;
  const job = pageJobs.get(page);
  if (!job) throw new Error('需要人工验证，请从网站发起任务');
  if (job.verificationError) throw job.verificationError;
  db.db.prepare('DELETE FROM verification_actions WHERE job_id = ?').run(job.jobId);
  const deadline = Date.now() + 5 * 60_000;
  let lastFrame = 0;
  try {
    while (await page.locator(CAPTCHA_DIALOG).count()) {
      if (Date.now() > deadline) throw new Error('人工验证超时，请重新运行任务');
      if (db.getJob(job.jobId)?.status !== 'running') throw new Error('任务已停止');
      if (Date.now() - lastFrame > 1000) {
        const image = (await page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64');
        db.addEvent(job.jobId, job.uid, 'verification', { image, ...page.viewportSize() });
        lastFrame = Date.now();
      }
      const actions = db.db.prepare('SELECT * FROM verification_actions WHERE job_id = ? ORDER BY id LIMIT 100').all(job.jobId);
      for (const action of actions) {
        db.db.prepare('DELETE FROM verification_actions WHERE id = ?').run(action.id);
        await page.mouse.move(action.x, action.y);
        if (action.kind === 'down') await page.mouse.down();
        if (action.kind === 'up') await page.mouse.up();
      }
      await sleep(80);
    }
    return true;
  } catch (error) {
    job.verificationError = error;
    throw error;
  } finally {
    await page.mouse.up().catch(() => {});
    db.db.prepare('DELETE FROM verification_actions WHERE job_id = ?').run(job.jobId);
    db.addEvent(job.jobId, job.uid, 'verification-end');
  }
}

/** 正常点击；只有人工验证完成后才重试，不强制绕过页面遮挡。 */
export async function safeClick(page, locator, opts = {}) {
  try {
    return await locator.click({ timeout: 6000, ...opts });
  } catch (e) {
    if (!(await page.locator('#JS_aliyun-captcha-dialog.show').count())) throw e;
    await clearCaptcha(page);
    return locator.click({ timeout: 8000, ...opts });
  }
}

/** 模拟人在页面上晃一下：移动鼠标 + 变速滚动，不总是匀速直线 */
async function humanScroll(page) {
  const height = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
  const y = 300 + Math.floor(Math.random() * 500);
  await page.mouse.move(200 + Math.floor(Math.random() * 800), y, { steps: 3 + Math.floor(Math.random() * 4) }).catch(() => {});
  await page.evaluate(() => {
    const h = document.body.scrollHeight;
    // 3% 概率往回滚一点，像人在回看
    const dir = Math.random() < 0.03 ? -1 : 1;
    const delta = (h / 120) * (0.5 + Math.random()) * dir;
    window.scrollTo(0, Math.max(0, Math.min(h, (window.scrollY || 0) + delta)));
  }).catch(() => {});
}

/** 一边停留一边慢慢下滑，页面靠可见区域和停留时长上报学习 */
export async function dwell(page, seconds, onTick) {
  const total = seconds * 1000;
  const step = 800 + Math.floor(Math.random() * 500);
  for (let passed = 0; passed < total; passed += step) {
    await humanScroll(page);
    await sleep(step);
    onTick?.(Math.floor((total - passed) / 1000));
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  // 每篇结束停一下，别像机器一样秒切下一页
  await sleep(jitter(1200, 2600));
}
