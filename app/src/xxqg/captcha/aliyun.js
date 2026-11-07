/**
 * 阿里云滑动验证码：定位 → 解码 → 求缺口 → 人类化拖动。
 *
 * 关键点：
 * 1. 拼图块与背景图都以 CSS background-image / <img src> 的形式存在，
 *    二者取自同一张底图，所以「块内像素在正确偏移处与背景重合」。
 * 2. 图片多来自 CDN（跨域），页面内 canvas 会 taint 导致 getImageData 抛错。
 *    因此由 Node 侧 fetch 拿字节，再以 data: URL 注入页面用 canvas 解码 —— 没有 CORS 问题。
 * 3. 拖动距离 = 缺口偏移 × (显示宽度 / 图像宽度)，鼠标坐标是 CSS 像素。
 */
import { findGapOffset, humanPath, toCssDistance } from './solver.js';

const RGBA = 4;

/** 页面内：把一段 data: URL 画进 canvas 并取回像素（base64 回传，避免大数组过桥） */
const DECODE_IN_PAGE = async (dataUrl) => {
  const img = new Image();
  img.src = dataUrl;
  if (img.decode) await img.decode();
  else await new Promise((res, rej) => ((img.onload = res), (img.onerror = rej)));
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < data.length; i += CH) s += String.fromCharCode.apply(null, data.subarray(i, i + CH));
  return { width: c.width, height: c.height, b64: btoa(s) };
};

/** 在验证码容器里找「背景图」和「拼图块」两个元素 */
export async function locateImages(page, dialogSelector = '#JS_aliyun-captcha-dialog, #aliyunCaptcha-sliding-body') {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) || document.body;
    const out = [];
    const grab = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      const cs = getComputedStyle(el);
      let url = '';
      const bg = cs.backgroundImage;
      const m = /url\(["']?(.+?)["']?\)/.exec(bg || '');
      if (m) url = m[1];
      if (!url && el.tagName === 'IMG') url = el.currentSrc || el.src;
      if (!url) return;
      out.push({
        cls: String(el.className || ''),
        id: el.id || '',
        tag: el.tagName,
        url,
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    };
    root.querySelectorAll('*').forEach(grab);
    return out;
  }, dialogSelector);
}

function pickPair(list) {
  const scorePiece = (e) => (/puzzle|block|piece|slice/i.test(e.cls + e.id) ? 1000 : 0) + (e.w * e.h < 40000 ? 100 : 0);
  const scoreBg = (e) => (/bg|background|canvas|img-area|picture/i.test(e.cls + e.id) ? 1000 : 0) + e.w * e.h / 1000;
  const sortedByPiece = [...list].sort((a, b) => scorePiece(b) - scorePiece(a));
  const sortedByBg = [...list].sort((a, b) => scoreBg(b) - scoreBg(a));
  const piece = sortedByPiece[0];
  const bg = sortedByBg.find((e) => e !== piece && e.w >= 40 && e.h >= 30) || sortedByBg[0];
  if (!piece || !bg || piece === bg) return null;
  return { piece, bg };
}

/** Node 侧把图片字节转成 data URL（绕开页面跨域限制） */
async function toDataUrl(url) {
  if (url.startsWith('data:')) return url;
  const res = await fetch(url, { headers: { referer: 'https://pc.xuexi.cn/' } });
  if (!res.ok) throw new Error(`拉取验证码图片失败 ${res.status}`);
  const type = res.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${type};base64,${buf.toString('base64')}`;
}

async function decode(page, url) {
  const dataUrl = await toDataUrl(url);
  const r = await page.evaluate(DECODE_IN_PAGE, dataUrl);
  return { width: r.width, height: r.height, data: new Uint8Array(Buffer.from(r.b64, 'base64')) };
}

/**
 * 判断验证码类型。阿里云这两个皮肤长得像、逻辑完全不同：
 *  - 'slide-to-end'：提示「请按住滑块，拖动到最右边」——没有缺口，拖到底即可；
 *  - 'puzzle'      ：有拼图块 + 背景图，需要解出缺口位置。
 * 判错类型会让求解器对着不存在的缺口算出一堆垃圾距离，所以先分类再解。
 */
export async function detectCaptchaKind(page, dialogSelector = '#JS_aliyun-captcha-dialog, #aliyunCaptcha-sliding-body') {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) || document.body;
    const text = (root.innerText || '').replace(/\s+/g, '');
    if (/拖动到最右|拖到最右|滑动到最右|最右边/.test(text)) return 'slide-to-end';
    // 有拼图块元素 → 缺口型
    const puzzle = root.querySelector(
      '.aliyunCaptcha-sliding-img-puzzle, #aliyunCaptcha-sliding-puzzle, [class*="puzzle"], [class*="slide-block"]',
    );
    if (puzzle) return 'puzzle';
    // 兜底：文本里明确是缺口
    if (/拼图|缺口|完成拼图/.test(text)) return 'puzzle';
    return 'slide-to-end';
  }, dialogSelector);
}

/** 取滑块手柄与轨道的盒子（CSS px）。超时设短，避免没有验证码时空等半分钟 */
async function sliderBoxes(page) {
  const box = async (sel) => {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) return null;
      return await loc.boundingBox({ timeout: 1500 });
    } catch {
      return null;
    }
  };
  let handle = await box('#aliyunCaptcha-sliding-slider, .aliyunCaptcha-sliding-slider, #nc_1_n1z');
  let track = await box('#aliyunCaptcha-sliding-body, .aliyunCaptcha-sliding-body, #nc_1__scale_text, #aliyunCaptcha-sliding-wrapper');
  if (handle && track) return { handle, track };

  // 兜底：按「可拖动的窄条」在容器里找
  const found = await findSliderByGeometry(page).catch(() => null);
  if (found) {
    handle = handle || found.handle;
    track = track || found.track;
  }
  return { handle, track };
}

/** 容器内按几何特征找手柄（窄、高、靠左）与轨道（宽、高） */
async function findSliderByGeometry(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#JS_aliyun-captcha-dialog') || document.querySelector('#aliyunCaptcha-sliding-body');
    if (!root) return null;
    const nodes = [...root.querySelectorAll('*')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: String(el.className || ''),
        id: el.id || '',
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        cursor: getComputedStyle(el).cursor,
      };
    });
    const visible = nodes.filter((n) => n.w > 4 && n.h > 4);
    const handle =
      visible
        .filter((n) => n.cursor === 'grab' || n.cursor === 'grab' || /slider|handle|btn/i.test(n.cls + n.id))
        .sort((a, b) => a.w - b.w)[0] ||
      visible.filter((n) => n.w >= 24 && n.w <= 64 && n.h >= 24).sort((a, b) => a.x - b.x)[0] ||
      null;
    const track = visible.filter((n) => n.w > 150 && n.h >= 24).sort((a, b) => b.w - a.w)[0] || null;
    if (!handle) return null;
    return {
      handle: { x: handle.x, y: handle.y, width: handle.w, height: handle.h },
      track: track ? { x: track.x, y: track.y, width: track.w, height: track.h } : null,
    };
  });
}

/** 排查用：把验证码容器里的元素清单压成一行日志 */
export async function dumpCaptchaDom(page, limit = 24) {
  try {
    return await page.evaluate((n) => {
      const root = document.querySelector('#JS_aliyun-captcha-dialog') || document.querySelector('#aliyunCaptcha-sliding-body');
      if (!root) return { text: '', nodes: [] };
      const nodes = [...root.querySelectorAll('*')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')} [${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}]`;
        })
        .filter((s) => !/ \s*0x0 /.test(s))
        .slice(0, n);
      return { text: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 80), nodes };
    }, limit);
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 在页面里量出滑块手柄与轨道。真实站点（2026-11-08 实测）结构：
 *   div#JS_aliyun-captcha-main            ← 整个弹窗（374x174）
 *     div#JS_aliyun-captcha-logo-wrapper  ← 红色横幅
 *     div#JS_aliyun-captcha-close-btn     ← 右上角 ×（30x30，别当成手柄）
 *     div#JS_aliyun-captcha-slider_bind_element [x,y 358x0]  ← 滑轨容器（高度为 0，子元素溢出）
 * 手柄是滑轨里那个 .aliyunCaptcha-sliding-slider（约 40x40）。
 */
async function measureSlider(page) {
  return page.evaluate(() => {
    const box = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const shown = (el) => {
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
    };

    const dialogs = [...document.querySelectorAll('#JS_aliyun-captcha-main, #JS_aliyun-captcha-dialog, [class*="captcha-main"]')].filter(shown);
    const root =
      dialogs.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })[0] || document.body;

    // 滑轨容器：优先真实 id，其次 radi текст「拖动」的那一行
    let rail = root.querySelector('#JS_aliyun-captcha-slider_bind_element, [id*="slider_bind"], [class*="slider_bind"]');
    if (!rail) {
      rail = [...root.querySelectorAll('*')].find((el) => {
        const r = el.getBoundingClientRect();
        return /按住滑块|拖动到最右/.test(el.textContent || '') && r.width >= 150;
      });
    }

    const railRect = rail ? rail.getBoundingClientRect() : null;

    // 手柄：滑轨内带 slider 类名的元素；没有再退化为滑轨内靠左的小方块
    let handle = null;
    if (rail) {
      const cand = [...rail.querySelectorAll('*')]
        .filter(shown)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter((n) => n.r.width >= 18 && n.r.width <= 80 && n.r.height >= 18 && n.r.height <= 80);
      const byClass = cand.find((n) => /slider|handle|btn/i.test(String(n.el.className || '') + n.el.id));
      handle = (byClass || cand.sort((a, b) => a.r.x - b.r.x)[0])?.r || null;
    }
    if (!handle) {
      handle =
        [...root.querySelectorAll('.aliyunCaptcha-sliding-slider, #aliyunCaptcha-sliding-slider, [class*="sliding-slider"]')]
          .filter(shown)
          .map((el) => el.getBoundingClientRect())[0] || null;
    }

    return {
      root: root ? box(root.getBoundingClientRect()) : null,
      track: railRect ? box(railRect) : null,
      handle: handle ? box(handle) : null,
    };
  });
}

/** 等滑块真正出现（弹窗有入场动画，元素可能晚几百毫秒才有尺寸） */
async function waitForSlider(page, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await measureSlider(page).catch(() => null);
    if (last?.handle && last?.track && last.track.width > 120) return last;
    await page.waitForTimeout(200);
  }
  return last;
}

/**
 * 「拖到最右边」型：距离 = 轨道右缘 − 手柄中心 − 2px 余量。
 * 不需要图像，任何缩放/皮肤都用同一套几何。
 */
export async function solveSlideToEnd(page, { log = () => {}, attempts = 3 } = {}) {
  const measured = await waitForSlider(page).catch((e) => ({ error: e.message }));
  const dom = await dumpCaptchaDom(page, 30);
  log({ step: 'dom', text: dom.text, handle: measured?.handle, track: measured?.track, nodes: dom.nodes });
  if (!measured?.handle || !measured?.track) {
    log({ step: 'no-handle', text: dom.text, nodes: dom.nodes });
    return { ok: false, reason: measured?.handle ? '找不到滑轨' : '找不到滑块手柄' };
  }

  // 拖到最右 = 让手柄右边缘贴到滑轨右边缘
  const startHandle = measured.handle;
  const trackRight = measured.track.x + measured.track.width;
  const startX = startHandle.x + startHandle.width / 2;
  const startY = startHandle.y + startHandle.height / 2;
  const distance = Math.round(Math.max(10, trackRight - (startHandle.x + startHandle.width) + 2));
  log({ step: 'plan', kind: 'slide-to-end', trackW: Math.round(measured.track.width), handleW: Math.round(startHandle.width), distance });
  if (!(distance > 20)) return { ok: false, reason: `计算出的距离异常（${distance}）` };

  // 诊断：这个点上到底是什么元素？有没有 iframe 盖在上面？（evaluate 只接受一个参数，包成对象）
  const probe = await page
    .evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const desc = (e) =>
        e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : 'null';
      const frames = [...document.querySelectorAll('iframe')].map((f) => {
        const r = f.getBoundingClientRect();
        return `${f.id || f.name || 'iframe'} [${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}]`;
      });
      return { at: desc(el), frames };
    }, { x: startX, y: startY })
    .catch((e) => ({ error: e.message }));
  log({ step: 'hit-test', at: probe?.at ?? null, frames: probe?.frames ?? null, err: probe?.error ?? null });

  let last = { ok: false, reason: '未执行' };
  for (let n = 1; n <= attempts; n++) {
    await page.mouse.move(startX - 2, startY - 1);
    await page.waitForTimeout(120 + Math.random() * 120);
    await page.mouse.down();
    const pts = humanPath(distance, { steps: 24 + Math.floor(Math.random() * 10), overshoot: 1.0, jitter: 0.35 });
    for (const p of pts) {
      await page.mouse.move(startX + p, startY + (Math.random() - 0.5) * 1.2);
      await page.waitForTimeout(12 + Math.random() * 18);
    }
    await page.mouse.move(startX + distance + 4, startY);
    await page.waitForTimeout(90 + Math.random() * 120);
    await page.mouse.up();
    await page.waitForTimeout(700);

    // 验收三件事：手柄是否移动 / 是否出现「验证通过」/ 弹窗是否消失
    const after = await measureSlider(page).catch(() => null);
    const moved = after?.handle ? Math.round(after.handle.x - startHandle.x) : -1;
    const box = await page
      .locator('#JS_aliyun-captcha-main, #JS_aliyun-captcha-dialog')
      .first()
      .boundingBox()
      .catch(() => null);
    const hint = await page
      .locator('#JS_aliyun-captcha-main, #JS_aliyun-captcha-dialog')
      .first()
      .innerText()
      .then((t) => t.replace(/\s+/g, ' ').slice(0, 40))
      .catch(() => '');
    const passed = /验证通过|通过验证|success/i.test(hint);
    const closed = !box || box.width === 0 || box.height === 0;
    log({ step: 'attempt', n, moved, passed, closed, hint });

    if (passed || closed) {
      return { ok: true, kind: 'slide-to-end', distance, offset: distance, moved, passed, closed, hint };
    }

    last = { ok: false, reason: `拖动后仍未通过（手柄移动 ${moved}px，目标 ${distance}px）`, distance, moved, hint };
    // 手柄压根没动 = 按下点没落在滑块上，值得再试；动了但没过 = 风控拒绝，别刷
    if (moved > distance * 0.6) break;
    if (n === attempts) {
      await page.screenshot({ path: 'data/captcha-fail.png', fullPage: false }).catch(() => {});
    }
  }
  return last;
}

/**
 * 求解并拖动（自动识别类型）。
 * @returns {{ok:boolean, kind?:string, reason?:string, offset?:number, distance?:number, score?:number}}
 */
export async function solveAndDrag(page, { log = () => {}, dialogSelector } = {}) {
  const kind = await detectCaptchaKind(page, dialogSelector).catch(() => 'slide-to-end');
  log({ step: 'detect', kind });
  if (kind === 'slide-to-end') {
    const r = await solveSlideToEnd(page, { log });
    return { ...r, kind: 'slide-to-end' };
  }

  const cands = await locateImages(page, dialogSelector);
  if (cands.length < 2) return { ok: false, kind, reason: `只找到 ${cands.length} 张候选图` };
  const pair = pickPair(cands);
  if (!pair) return { ok: false, kind, reason: '没能区分背景图与拼图块' };
  log({ step: 'locate', bg: pair.bg.cls || pair.bg.tag, piece: pair.piece.cls || pair.piece.tag });

  const [bgImg, pieceImg] = await Promise.all([decode(page, pair.bg.url), decode(page, pair.piece.url)]);
  log({ step: 'decoded', bg: `${bgImg.width}x${bgImg.height}`, piece: `${pieceImg.width}x${pieceImg.height}` });

  const solved = findGapOffset(bgImg.data, bgImg.width, bgImg.height, pieceImg.data, pieceImg.width, pieceImg.height);
  const cssW = pair.bg.w;
  const distance = toCssDistance(solved.offset, bgImg.width, cssW);
  log({ step: 'solved', offset: solved.offset, distance: Math.round(distance), score: Math.round(solved.score) });
  if (!(distance > 5)) return { ok: false, reason: `求解出的距离异常（${distance}）`, offset: solved.offset, distance };

  // 拖动：从滑块手柄中心出发，按人类化轨迹移动
  const handle = await page
    .locator('#aliyunCaptcha-sliding-slider, .aliyunCaptcha-sliding-slider, #nc_1_n1z')
    .first()
    .boundingBox();
  if (!handle) return { ok: false, reason: '找不到滑块手柄' };
  const startX = handle.x + handle.width / 2;
  const startY = handle.y + handle.height / 2;

  await page.mouse.move(startX, startY);
  await page.waitForTimeout(120 + Math.random() * 160);
  await page.mouse.down();
  const pts = humanPath(distance, { steps: 26 + Math.floor(Math.random() * 8) });
  let prev = 0;
  for (const p of pts) {
    const dx = p - prev;
    prev = p;
    await page.mouse.move(startX + p, startY + (Math.random() - 0.5) * 1.6, { steps: 1 });
    await page.waitForTimeout(8 + dx * 0.35 + Math.random() * 18);
  }
  await page.mouse.move(startX + distance, startY);
  await page.waitForTimeout(90 + Math.random() * 120);
  await page.mouse.up();

  return { ok: true, kind: 'puzzle', offset: solved.offset, distance, score: solved.score };
}
