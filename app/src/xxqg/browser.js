import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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
export async function newSession(jar, { uid } = {}) {
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

/**
 * 阿里云滑块。出现就拖过去，拖动走缓动 + 抖动，末尾还回弹一下。
 * 返回是否已经清掉。
 */
export async function clearCaptcha(page) {
  const dialog = page.locator('#JS_aliyun-captcha-dialog.show').first();
  if (!(await dialog.count())) return true;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const btn = page.locator('#nc_1_n1z').first();
    if (!(await btn.count())) {
      // 不是滑块形态（弹窗/图片），点空白处关掉试试
      await page.mouse.click(10, 10).catch(() => {});
      await sleep(800);
      if (!(await page.locator('#JS_aliyun-captcha-dialog.show').count())) return true;
      continue;
    }
    const box = await btn.boundingBox().catch(() => null);
    const track = await page.locator('#nc_1__scale_text').first().boundingBox().catch(() => null);
    if (!box || !track) return false;

    const distance = (track.width - box.width) * (0.95 + Math.random() * 0.03);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY).catch(() => {});
    await sleep(120 + Math.random() * 180);
    await page.mouse.down().catch(() => {});

    const steps = 24 + Math.floor(Math.random() * 10);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3); // 先快后慢，像人手
      const x = startX + distance * ease + (Math.random() - 0.5) * 1.5;
      const y = startY + (Math.random() - 0.5) * 4;
      await page.mouse.move(x, y);
      await sleep(10 + Math.random() * 22);
    }
    // 收尾回拉一点，滑块验证爱看这个
    await page.mouse.move(startX + distance - 3, startY).catch(() => {});
    await sleep(150);
    await page.mouse.up().catch(() => {});
    await sleep(1600);

    if (!(await page.locator('#JS_aliyun-captcha-dialog.show').count())) return true;
    console.log('[captcha] 第 %d 次没过，重试', attempt);
    await sleep(1200);
  }
  return !(await page.locator('#JS_aliyun-captcha-dialog.show').count());
}

/** 点击；被验证码挡住就先过验证码再点 */
export async function safeClick(page, locator, opts = {}) {
  try {
    return await locator.click({ timeout: 8000, ...opts });
  } catch (e) {
    if (!(await page.locator('#JS_aliyun-captcha-dialog.show').count())) throw e;
    await clearCaptcha(page);
    return locator.click({ timeout: 15000, ...opts });
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
