// 求解器单元测试：用合成图像验证「能找回已知偏移」，不依赖任何真实验证码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGapOffset, humanPath, toCssDistance } from '../src/domain/captcha/solver.js';

/** 确定性伪随机，保证用例可复现 */
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** 生成一张「有纹理」的背景，避免纯色导致任何偏移都零误差 */
function makeBackground(w, h, rng) {
  const bg = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      bg[i] = (x * 3 + y * 5 + Math.floor(rng() * 40)) & 0xff;
      bg[i + 1] = (x * 7 + y * 2 + Math.floor(rng() * 40)) & 0xff;
      bg[i + 2] = (x * 11 + y * 13 + Math.floor(rng() * 40)) & 0xff;
      bg[i + 3] = 255;
    }
  }
  return bg;
}

/** 从背景里抠一块 (gapX,gapY) 处的拼图块，块外透明 */
function cutPiece(bg, bgW, gapX, gapY, pw, ph) {
  const piece = new Uint8Array(pw * ph * 4);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const si = ((gapY + y) * bgW + (gapX + x)) * 4;
      const di = (y * pw + x) * 4;
      const edge = x === 0 || y === 0 || x === pw - 1 || y === ph - 1;
      piece[di] = bg[si];
      piece[di + 1] = bg[si + 1];
      piece[di + 2] = bg[si + 2];
      piece[di + 3] = edge ? 0 : 255;
    }
  }
  return piece;
}

test('能从合成图里找回已知缺口偏移', () => {
  const rng = makeRng(7);
  const bgW = 320;
  const bgH = 120;
  const bg = makeBackground(bgW, bgH, rng);
  const pw = 48;
  const ph = 48;
  const gapX = 137;
  const gapY = 36;
  const piece = cutPiece(bg, bgW, gapX, gapY, pw, ph);

  const r = findGapOffset(bg, bgW, bgH, piece, pw, ph);
  // 块图有一圈透明边，bbox 在 (1,1)，所以求解坐标 = gap + 1
  assert.ok(Math.abs(r.offset - (gapX + 1)) <= 1, `期望约 ${gapX + 1}，实际 ${r.offset}（score=${r.score.toFixed(2)}）`);
  assert.ok(Math.abs(r.offsetY - (gapY + 1)) <= 1, `纵向期望约 ${gapY + 1}，实际 ${r.offsetY}`);
  assert.ok(r.score < 6, `最优分数应当很小，实际 ${r.score}`);
  assert.ok(r.samples > 30);
});

test('多个偏移位置都能解出来（含 0 和接近右边界）', () => {
  const rng = makeRng(11);
  const bgW = 300;
  const bgH = 100;
  const bg = makeBackground(bgW, bgH, rng);
  const pw = 40;
  const ph = 40;
  for (const gapX of [0, 31, 118, 200, bgW - pw]) {
    const piece = cutPiece(bg, bgW, gapX, 30, pw, ph);
    const r = findGapOffset(bg, bgW, bgH, piece, pw, ph);
    assert.ok(Math.abs(r.offset - (gapX + 1)) <= 1, `gapX=${gapX} 期望约 ${gapX + 1}，实际 ${r.offset}`);
  }
});

test('整块透明时报错，而不是返回随机值', () => {
  const bg = makeBackground(100, 50, makeRng(1));
  const piece = new Uint8Array(20 * 20 * 4); // 全 0
  assert.throws(() => findGapOffset(bg, 100, 50, piece, 20, 20), /整块透明|有效像素太少/);
});

test('尺寸非法时报错', () => {
  const bg = makeBackground(100, 50, makeRng(2));
  const piece = new Uint8Array(20 * 20 * 4).fill(255);
  assert.throws(() => findGapOffset(bg, 10, 50, piece, 20, 20), /背景比拼图块还窄/);
  assert.throws(() => findGapOffset(bg, 100, 10, piece, 20, 20), /拼图块比背景还高/);
});

test('humanPath：收尾精确、过冲不超过 1.5%', () => {
  const d = 180;
  const pts = humanPath(d, { steps: 30, rng: makeRng(3) });
  assert.equal(pts.length, 30);
  assert.equal(pts[pts.length - 1], d, '最后一步必须精确落点');
  const max = Math.max(...pts);
  assert.ok(max <= d * 1.015, `过冲应很小，实际 ${max}`);
});

test('toCssDistance：图像缩放到显示宽度', () => {
  assert.equal(toCssDistance(100, 320, 320), 100);
  assert.equal(toCssDistance(100, 320, 160), 50);
  assert.equal(toCssDistance(100, 0, 160), 100, '参数异常时原样返回');
});
