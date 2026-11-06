import { chromium, firefox } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../config.js';

let browser = null;
// 滑块风控把「有 CDP 调试口」当成 devtools 入侵，Chromium 里怎么拟人都过不去；
// 换成 Playwright 自驱的 Firefox（Juggler 协议，没有 CDP）绕开这条判定。
const USE_FF = /^(firefox|ff)$/i.test(process.env.XXQG_ENGINE || '');

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--mute-audio',
  '--disable-features=RendererCodeIntegrity,IsolateOrigins,site-per-process',
];

export const HEADED = /^(1|true|yes)$/i.test(process.env.XXQG_HEADED || '');

export async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (USE_FF) {
    browser = await firefox.launch({ headless: !HEADED, firefoxUserPrefs: { 'dom.webdriver.enabled': false } });
  } else {
    browser = await chromium.launch({
      // 本机有 Chrome 用 Chrome，容器里用 CHROME_PATH 指向 chromium
      channel: config.chromePath ? undefined : process.env.CHROME_CHANNEL || 'chrome',
      executablePath: config.chromePath || undefined,
      headless: !HEADED,
      args: HEADED ? [...LAUNCH_ARGS, '--window-size=1440,940', '--window-position=0,0'] : LAUNCH_ARGS,
    });
  }
  browser.on('disconnected', () => {
    browser = null;
  });
  return browser;
}

export async function closeBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
}

// Firefox 只用最小伪装：没有 chrome 对象，别硬塞
const FF_STEALTH = () => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  } catch {}
};

// 抹掉自动化痕迹：webdriver、空 plugins、chrome 对象、WebGL 厂商
const STEALTH = () => {
  // 真 Chrome 里是 false，不是 undefined，删属性反而露馅
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
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
    // headless 下 Chrome 的 UA 带 "HeadlessChrome"，前端指纹会直接记成 Chrome Headless。
    // 用真 Chrome 的 UA 覆盖，别的字段（UA-CH、WebGL）本来就不带 headless 标记。
    userAgent: USE_FF || HEADED
      ? undefined
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    viewport: HEADED ? null : { width: 1440 + Math.floor(Math.random() * 60), height: 900 },
    deviceScaleFactor: HEADED ? undefined : 1,
    extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    storageState: state,
  });
  await ctx.addInitScript(USE_FF ? FF_STEALTH : STEALTH);
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

const CAPTCHA_DIALOG = '#JS_aliyun-captcha-dialog.show';
// 阿里云两套滑块皮肤，按钮和轨道的 id 不一样
const SLIDER_BUTTONS = ['#aliyunCaptcha-sliding-slider', '#nc_1_n1z', '.aliyunCaptcha-sliding-slider'];
const SLIDER_TRACKS = ['#aliyunCaptcha-sliding-body', '#nc_1__scale_text', '#aliyunCaptcha-sliding-wrapper'];

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      const box = await loc.boundingBox().catch(() => null);
      if (box) return { loc, box };
    }
  }
  return null;
}

// CDP 里解滑块必挂（见 docs/HANDOFF.md），走无 CDP 交卷时把这里关掉，别浪费时间
let captchaSolverEnabled = true;
export function setCaptchaSolverEnabled(on) {
  captchaSolverEnabled = !!on;
}

/**
 * 阿里云滑块。出现就拖过去，拖动走缓动 + 抖动，末尾还回弹一下。
 * 返回是否已经清掉。
 */
export async function clearCaptcha(page) {
  if (!captchaSolverEnabled) return false;
  if (!(await page.locator(CAPTCHA_DIALOG).count())) return true;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const slider = await firstVisible(page, SLIDER_BUTTONS);
    const track = await firstVisible(page, SLIDER_TRACKS);
    if (!slider || !track) {
      // 不是滑块形态（弹窗/图片），点空白处关掉试试
      await page.mouse.click(10, 10).catch(() => {});
      await sleep(800);
      if (!(await page.locator(CAPTCHA_DIALOG).count())) return true;
      continue;
    }

    const { box } = slider;
    const distance = Math.max(20, track.box.width - box.width - 2) * (0.97 + Math.random() * 0.02);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // 先用真实 OS 鼠标拖：阿里云只认操作系统输入栈来的事件，CDP 合成事件必 403
    const dragged = await osDrag(page, startX, startY, startX + distance, startY).catch(() => false);
    if (dragged) {
      await sleep(2000);
      if (!(await page.locator(CAPTCHA_DIALOG).count())) {
        console.log('[captcha] OS 鼠标拖拽通过');
        return true;
      }
      const a1 = await slider.loc.boundingBox().catch(() => null);
      console.log('[captcha] OS 拖完滑块 x=%s', a1 ? Math.round(a1.x) : 'null');
    }

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

    if (!(await page.locator(CAPTCHA_DIALOG).count())) return true;

    // 有的皮肤不吃 CDP 鼠标事件，滑块根本没动 → 改派指针事件
    const after = await slider.loc.boundingBox().catch(() => null);
    console.log('[captcha] attempt %d sliderX %s -> %s', attempt, Math.round(box.x), after ? Math.round(after.x) : 'null');
    if (after && Math.abs(after.x - box.x) < 3) {
      await dragByPointerEvents(page, startX, startY, distance);
      await sleep(1800);
      if (!(await page.locator(CAPTCHA_DIALOG).count())) return true;
      const after2 = await slider.loc.boundingBox().catch(() => null);
      console.log('[captcha] pointer fallback sliderX %s', after2 ? Math.round(after2.x) : 'null');
    }

    console.log('[captcha] 第 %d 次没过，重试', attempt);
    await sleep(1200);
  }
  return !(await page.locator(CAPTCHA_DIALOG).count());
}

/** 兜底：在页面里直接派发 pointerdown/pointermove/pointerup */
async function dragByPointerEvents(page, startX, startY, distance) {
  await page
    .evaluate(
      async ([sx, sy, dist]) => {
        const el = document.querySelector('#aliyunCaptcha-sliding-slider, #nc_1_n1z');
        if (!el) return;
        const fire = (type, x, y) => {
          const ev = new PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
            buttons: type === 'pointerup' ? 0 : 1,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
          });
          (type === 'pointerdown' ? el : document).dispatchEvent(ev);
        };
        fire('pointerdown', sx, sy);
        for (let i = 1; i <= 30; i++) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 20));
          fire('pointermove', sx + (dist * i) / 30, sy);
        }
        await new Promise((r) => setTimeout(r, 300));
        fire('pointerup', sx + dist, sy);
      },
      [startX, startY, distance],
    )
    .catch(() => {});
  await sleep(200);
}

/**
 * 用真实 OS 鼠标在浏览器窗口里拖一把：页面 css 坐标 → 屏幕物理像素，交给 scripts/native.ps1。
 * 本机是 2 倍屏，窗口的 screenX/screenY 按 css 给，统一乘 2。
 */
async function osDrag(page, x1, y1, x2, y2) {
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
  if (!geo) return false;
  const oy = geo.sy * 2 + geo.oh * 2 - geo.ih * geo.d;
  const ox = geo.sx * 2 + (geo.ow * 2 - geo.iw * geo.d) / 2;
  const args = [
    '-Action', 'drag',
    '-A1', String(Math.round(ox + x1 * geo.d)),
    '-A2', String(Math.round(oy + y1 * geo.d)),
    '-A3', String(Math.round(ox + x2 * geo.d)),
    '-A4', String(Math.round(oy + y2 * geo.d)),
    '-A5', '30',
  ];
  await new Promise((res, rej) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/native.ps1', ...args],
      { cwd: process.cwd(), timeout: 40000 },
      (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out)),
    );
  });
  return true;
}

/** 点击；被验证码挡住就先过验证码再点；再不济强制派发 */
export async function safeClick(page, locator, opts = {}) {
  try {
    return await locator.click({ timeout: 6000, ...opts });
  } catch (e) {
    if (await page.locator('#JS_aliyun-captcha-dialog.show').count()) await clearCaptcha(page);
    try {
      return await locator.click({ timeout: 8000, ...opts });
    } catch {
      return locator.click({ force: true, ...opts });
    }
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
