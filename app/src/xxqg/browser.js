import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import * as db from '../db.js';
// 缺口自动解码器（app 内自带一份，容器构建上下文只包含 app/，不能引用仓库外路径）
import { solveAndDrag } from './captcha/aliyun.js';

const pageJobs = new WeakMap();

let browser = null;
let launching = null;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--mute-audio',
  '--disable-features=RendererCodeIntegrity,IsolateOrigins,site-per-process',
];

/**
 * 有头模式开关：验证码的真实鼠标兜底必须有一个真实窗口，
 * headless 下 SendInput 无处可落，风控也只会看到合成事件。
 * 用 XXQG_HEADED=1 打开；默认仍是 headless（容器/服务器不需要桌面）。
 */
const HEADED = /^(1|true|yes)$/i.test(process.env.XXQG_HEADED || '');
export const isHeaded = () => HEADED;

export async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  launching = chromium.launch({
    // 本机有 Chrome 用 Chrome，容器里用 CHROME_PATH 指向 chromium
    channel: config.chromePath ? undefined : process.env.CHROME_CHANNEL || 'chrome',
    executablePath: config.chromePath || undefined,
    headless: !HEADED,
    args: HEADED ? [...LAUNCH_ARGS, '--window-position=0,0', '--window-size=1280,900'] : LAUNCH_ARGS,
  }).then(instance => {
    browser = instance;
    instance.on('disconnected', () => {
      if (browser === instance) browser = null;
    });
    return instance;
  }).finally(() => { launching = null; });
  return launching;
}

export async function closeBrowser() {
  if (launching) await launching.catch(() => {});
  const current = browser;
  if (current) await current.close().catch(() => {});
  if (browser === current) browser = null;
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
export async function newSession(jar, { uid, jobId, shouldStop } = {}) {
  const b = await getBrowser();
  const state = uid ? loadProfile(uid) : undefined;
  const ctx = await b.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    // 有头模式下不锁 viewport：让页面尺寸跟真实窗口一致，SendInput 的坐标换算才对得上
    viewport: HEADED ? null : { width: 1440 + Math.floor(Math.random() * 60), height: 900 },
    deviceScaleFactor: HEADED ? undefined : 1,
    extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    storageState: state,
  });
  await ctx.addInitScript(STEALTH);
  if (jar) await ctx.addCookies(jar.toPlaywrightCookies());
  const page = await ctx.newPage();
  if (jobId) pageJobs.set(page, { jobId, uid, shouldStop });

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
export async function sleep(ms, checkPause) {
  if (!checkPause) return new Promise(resolve => setTimeout(resolve, ms));
  for (let remaining = ms; remaining > 0; remaining -= 1000) {
    checkPause();
    await sleep(Math.min(1000, remaining));
  }
}
export const jitter = (base, spread = 4000) => base + Math.floor(Math.random() * spread);

const CAPTCHA_DIALOG = '#JS_aliyun-captcha-dialog.show';
const SLIDER_HANDLE = '#aliyunCaptcha-sliding-slider, .aliyunCaptcha-sliding-slider, #nc_1_n1z';

/**
 * 用「真实 OS 鼠标」把滑块拖过去（SendInput）。
 * CDP 合成事件会被风控判定为自动化，而 2x 屏 + 真实输入是历史上唯一通过过的组合。
 * 依赖 app/scripts/native.ps1，且只有 Windows 有桌面会话时可用。
 */
async function osDragSlider(page, distanceCss) {
  if (process.platform !== 'win32') return false;
  const geo = await page
    .evaluate(() => ({
      sx: window.screenX,
      sy: window.screenY,
      ow: window.outerWidth,
      oh: window.outerHeight,
      iw: window.innerWidth,
      ih: window.innerHeight,
      d: window.devicePixelRatio,
    }))
    .catch(() => null);
  const handle = await page.locator(SLIDER_HANDLE).first().boundingBox().catch(() => null);
  if (!geo || !handle) return false;

  // 屏幕缩放：window.screenX/screenY 是 CSS 像素，SendInput 要物理像素
  const scale = geo.d >= 1.5 ? 2 : 1;
  const oy = geo.sy * scale + geo.oh * scale - geo.ih * geo.d;
  const ox = geo.sx * scale + (geo.ow * scale - geo.iw * geo.d) / 2;
  const x1 = Math.round(ox + (handle.x + handle.width / 2) * geo.d);
  const y1 = Math.round(oy + (handle.y + handle.height / 2) * geo.d);
  const x2 = Math.round(x1 + distanceCss * geo.d);
  console.log('[captcha] OS 拖动坐标 geo=%j handle=%j -> (%d,%d) → (%d,%d)', geo, handle, x1, y1, x2, y1);
  await new Promise((res, rej) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/native.ps1', '-Action', 'drag', '-A1', String(x1), '-A2', String(y1), '-A3', String(x2), '-A4', String(y1), '-A5', '34'],
      { cwd: process.cwd(), timeout: 40_000 },
      (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out)),
    );
  });
  return true;
}

/**
 * 验证码处置顺序：
 *   1) 缺口自动解码 + CDP 合成拖动（快，先试）；
 *   2) 解码出的距离再用「真实 OS 鼠标」拖一次（风控对输入来源敏感）；
 *   3) 仍不通过 → 回到人工验证：把画面推给网站，转发用户真实输入。
 * 自动解码只解决「拖到哪儿」；失败不无限重试，避免抬高账号风险分。
 */
export async function clearCaptcha(page) {
  if (!(await page.locator(CAPTCHA_DIALOG).count())) return true;

  // 没有任务上下文就没有人工验证通道，也没有日志归属：直接报错，别做无主拖拽
  const job = pageJobs.get(page);
  if (!job) throw new Error('需要人工验证，请从网站发起任务');
  if (job.verificationError) throw job.verificationError;

  const solved = await solveAndDrag(page, {
    log: (m) => console.log('[captcha-solve]', JSON.stringify(m)),
  }).catch((e) => ({ ok: false, reason: e.message }));

  if (solved.ok) {
    await sleep(1500);
    if (!(await page.locator(CAPTCHA_DIALOG).count())) {
      console.log('[captcha] 自动通过（kind=%s，距离=%s）', solved.kind, Math.round(solved.distance));
      return true;
    }
    console.log('[captcha] 合成拖动未被接受（kind=%s，距离=%s），改用真实鼠标重拖', solved.kind, Math.round(solved.distance));

    // 第二击：同一条距离，换成操作系统输入栈的鼠标
    const os = await osDragSlider(page, solved.distance).catch((e) => {
      console.log('[captcha] OS 拖动不可用：%s', e.message);
      return false;
    });
    if (os) {
      await sleep(2000);
      if (!(await page.locator(CAPTCHA_DIALOG).count())) {
        console.log('[captcha] 真实鼠标拖动通过（距离=%s）', Math.round(solved.distance));
        return true;
      }
      console.log('[captcha] 真实鼠标拖动仍未被接受，转人工验证');
    }
  } else {
    console.log('[captcha] 自动解码未成功：%s，转人工验证', solved.reason || '未知');
  }

  // 落到这里说明自动方案没成：把画面推给用户，转发真实输入
  db.db.prepare('DELETE FROM verification_actions WHERE job_id = ?').run(job.jobId);
  const deadline = Date.now() + 5 * 60_000;
  let lastFrame = 0;
  try {
    while (await page.locator(CAPTCHA_DIALOG).count()) {
      job.shouldStop?.();
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
