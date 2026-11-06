import { findGapOffset, alphaBBox } from '../src/domain/captcha/solver.js';

function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
function makeBackground(w, h, rng) {
  const bg = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      bg[i] = (x * 3 + y * 5 + Math.floor(rng() * 40)) & 0xff;
      bg[i + 1] = (x * 7 + y * 2 + Math.floor(rng() * 40)) & 0xff;
      bg[i + 2] = (x * 11 + y * 13 + Math.floor(rng() * 40)) & 0xff;
      bg[i + 3] = 255;
    }
  return bg;
}
function cutPiece(bg, bgW, gapX, gapY, pw, ph) {
  const piece = new Uint8Array(pw * ph * 4);
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      const si = ((gapY + y) * bgW + (gapX + x)) * 4;
      const di = (y * pw + x) * 4;
      const edge = x === 0 || y === 0 || x === pw - 1 || y === ph - 1;
      piece[di] = bg[si];
      piece[di + 1] = bg[si + 1];
      piece[di + 2] = bg[si + 2];
      piece[di + 3] = edge ? 0 : 255;
    }
  return piece;
}

const bgW = 320, bgH = 120, pw = 48, ph = 48, gapX = 137, gapY = 36;
const bg = makeBackground(bgW, bgH, makeRng(7));
const piece = cutPiece(bg, bgW, gapX, gapY, pw, ph);
console.log('bbox', alphaBBox(piece, pw, ph));

// 手工算：在 (gapX+1, gapY+1) 处的平均绝对差（bbox 相对坐标）
const bbox = alphaBBox(piece, pw, ph);
let sum = 0, cnt = 0;
for (let y = bbox.y + 2; y < bbox.y + bbox.h - 2; y++)
  for (let x = bbox.x + 2; x < bbox.x + bbox.w - 2; x++) {
    const bx = gapX + x, by = gapY + y;
    const bi = (by * bgW + bx) * 4;
    const pi = (y * pw + x) * 4;
    sum += Math.abs(bg[bi] - piece[pi]) + Math.abs(bg[bi + 1] - piece[pi + 1]) + Math.abs(bg[bi + 2] - piece[pi + 2]);
    cnt++;
  }
console.log('manual score at truth', (sum / cnt).toFixed(3));

const r = findGapOffset(bg, bgW, bgH, piece, pw, ph);
console.log('solver', r, 'expected dx', gapX, 'dy', gapY);
