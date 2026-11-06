/**
 * 滑块拼图「缺口位置」求解器 —— 纯像素运算，无第三方图像库。
 *
 * 原理：滑动验证的拼图块是从背景图里原样抠出来的。
 * 在正确位置 (dx, dy) 处，块内像素与背景对应区域几乎完全相同；
 * 于是求解退化成：在小范围内找「平均绝对差」最小的 (dx, dy)。
 *
 * 输入都是同一缩放的 RGBA，结果也是图像坐标系；
 * 换算成鼠标距离时再乘以 (显示宽度 / 图像宽度)。
 */

const RGBA = 4;
const ALPHA_MIN = 128;

/** 计算拼图块不透明区域的包围盒 */
export function alphaBBox(piece, pieceW, pieceH, alphaThreshold = ALPHA_MIN) {
  let minX = pieceW;
  let minY = pieceH;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < pieceH; y++) {
    for (let x = 0; x < pieceW; x++) {
      if (piece[(y * pieceW + x) * RGBA + 3] < alphaThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * 盒式下采样：让匹配对 ±1 像素的错位不敏感。
 * 真实验证码背景是照片，缩小后仍保留结构；噪声图缩小后差异被平均掉。
 */
export function downscale(rgba, w, h, factor) {
  const nw = Math.max(1, Math.floor(w / factor));
  const nh = Math.max(1, Math.floor(h / factor));
  const out = new Float32Array(nw * nh * RGBA);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= w || sy >= h) continue;
          const i = (sy * w + sx) * RGBA;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
          n += 1;
        }
      }
      const o = (y * nw + x) * RGBA;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: nw, height: nh };
}

/**
 * 在背景里找拼图块的位置。
 * 两段式：先 4× 下采样粗搜（对 ±1 像素鲁棒），再回全分辨率在最优附近精修。
 * @returns {{offset:number, offsetY:number, score:number, ...}}
 */
export function findGapOffset(bg, bgW, bgH, piece, pieceW, pieceH, opts = {}) {
  const { alphaThreshold = ALPHA_MIN } = opts;
  if (!bg || !piece) throw new Error('缺少图像数据');
  if (!(pieceW > 0) || !(pieceH > 0)) throw new Error('拼图块尺寸非法');
  if (bgW < pieceW) throw new Error('背景比拼图块还窄');
  if (pieceH > bgH) throw new Error('拼图块比背景还高');

  const bbox = alphaBBox(piece, pieceW, pieceH, alphaThreshold);
  if (!bbox) throw new Error('拼图块整块透明，截错元素了');
  if (bbox.w < 6 || bbox.h < 6) throw new Error(`有效区域太小（${bbox.w}x${bbox.h}）`);

  // 提取块内像素（包围盒内、去掉 1px 边缘抗锯齿）
  const px = [];
  const py = [];
  const pr = [];
  const pg = [];
  const pb = [];
  for (let y = bbox.y + 1; y < bbox.y + bbox.h - 1; y++) {
    for (let x = bbox.x + 1; x < bbox.x + bbox.w - 1; x++) {
      const i = (y * pieceW + x) * RGBA;
      if (piece[i + 3] < alphaThreshold) continue;
      px.push(x - bbox.x);
      py.push(y - bbox.y);
      pr.push(piece[i]);
      pg.push(piece[i + 1]);
      pb.push(piece[i + 2]);
    }
  }
  const n = px.length;
  if (n < 30) throw new Error(`拼图块有效像素太少（${n}），可能整块透明或截错元素`);

  // 允许的最右位置以「可见宽度」为准（块图四周常有透明边，用 pieceW 会把右侧裁掉）
  const maxDx = Math.min(opts.maxOffset ?? Infinity, bgW - bbox.w - bbox.x);
  const maxDy = Math.max(0, bgH - bbox.h - bbox.y);

  // 采样：最多 256 个像素，保证 (maxDx × maxDy × 256) 量级在几毫秒内算完
  const stride = Math.max(1, Math.ceil(n / 256));
  const sPx = [];
  const sPy = [];
  const sR = [];
  const sG = [];
  const sB = [];
  for (let k = 0; k < n; k += stride) {
    sPx.push(px[k]);
    sPy.push(py[k]);
    sR.push(pr[k]);
    sG.push(pg[k]);
    sB.push(pb[k]);
  }

  const scoreAt = (dx, dy) => {
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < sPx.length; k++) {
      const bx = dx + sPx[k];
      const by = dy + sPy[k];
      if (bx < 0 || bx >= bgW || by < 0 || by >= bgH) continue;
      const bi = (by * bgW + bx) * RGBA;
      sum += Math.abs(bg[bi] - sR[k]) + Math.abs(bg[bi + 1] - sG[k]) + Math.abs(bg[bi + 2] - sB[k]);
      cnt += 1;
    }
    return cnt ? sum / cnt : Infinity;
  };

  // 全分辨率二维穷举（dx、dy 都逐像素），再在最优处用全部像素复核
  let best = { offset: 0, offsetY: 0, score: Infinity };
  for (let dy = 0; dy <= maxDy; dy++) {
    for (let dx = 0; dx <= maxDx; dx++) {
      const s = scoreAt(dx, dy);
      if (s < best.score) best = { offset: dx, offsetY: dy, score: s };
    }
  }

  // 用「全部有效像素」复核最优解，避免采样漏掉尖锐结构
  const fullScoreAt = (dx, dy) => {
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < n; k++) {
      const bx = dx + px[k];
      const by = dy + py[k];
      if (bx < 0 || bx >= bgW || by < 0 || by >= bgH) continue;
      const bi = (by * bgW + bx) * RGBA;
      sum += Math.abs(bg[bi] - pr[k]) + Math.abs(bg[bi + 1] - pg[k]) + Math.abs(bg[bi + 2] - pb[k]);
      cnt += 1;
    }
    return cnt ? sum / cnt : Infinity;
  };
  let refined = { ...best, score: fullScoreAt(best.offset, best.offsetY) };
  for (let dy = Math.max(0, best.offsetY - 2); dy <= Math.min(maxDy, best.offsetY + 2); dy++) {
    for (let dx = Math.max(0, best.offset - 2); dx <= Math.min(maxDx, best.offset + 2); dx++) {
      const s = fullScoreAt(dx, dy);
      if (s < refined.score) refined = { offset: dx, offsetY: dy, score: s };
    }
  }

  return { ...refined, samples: n, candidates: (maxDx + 1) * (maxDy + 1), bbox };
}

/** 图像坐标 → 页面 CSS 像素（track 显示宽度 / 图像宽度） */
export function toCssDistance(offset, imageWidth, displayWidth) {
  if (!(imageWidth > 0) || !(displayWidth > 0)) return offset;
  return (offset * displayWidth) / imageWidth;
}

/**
 * 人类化轨迹：先快后慢（ease-out）、轻微过冲再回拉、逐帧抖动。
 * 输出相对起点的位移序列（CSS px），最后一个点严格等于 distance。
 */
export function humanPath(distance, { steps = 28, overshoot = 1.004, jitter = 0.6, rng = Math.random } = {}) {
  if (!(distance > 0)) return [0];
  const target = distance * overshoot;
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3);
    pts.push(target * eased + (rng() - 0.5) * jitter);
  }
  pts[pts.length - 1] = distance; // 收尾精确落点，避免过冲被判定为错
  return pts;
}
