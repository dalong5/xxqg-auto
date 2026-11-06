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
 * 求解并拖动。
 * @returns {{ok:boolean, reason?:string, offset?:number, distance?:number, score?:number}}
 */
export async function solveAndDrag(page, { log = () => {}, dialogSelector } = {}) {
  const cands = await locateImages(page, dialogSelector);
  if (cands.length < 2) return { ok: false, reason: `只找到 ${cands.length} 张候选图` };
  const pair = pickPair(cands);
  if (!pair) return { ok: false, reason: '没能区分背景图与拼图块' };
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

  return { ok: true, offset: solved.offset, distance, score: solved.score };
}
