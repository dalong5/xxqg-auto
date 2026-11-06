// 端到端：真实浏览器 + 模拟阿里云 DOM，验证「定位 → 解码 → 求缺口 → 拖动」全链路
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { solveAndDrag, locateImages } from '../src/domain/captcha/aliyun.js';

const GAP_X = 118;
const IMG_W = 300;
const IMG_H = 120;
const PIECE = 44;

/** 生成一个模拟阿里云滑动验证的页面：背景 + 拼图块 + 滑轨，并记录拖动距离 */
function pageHtml() {
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#111}
    #JS_aliyun-captcha-dialog{position:relative;width:${IMG_W}px;height:${IMG_H + 60}px;margin:20px}
    .aliyunCaptcha-sliding-img-bg{position:absolute;left:0;top:0;width:${IMG_W}px;height:${IMG_H}px}
    .aliyunCaptcha-sliding-img-puzzle{position:absolute;left:0;top:26px;width:${PIECE}px;height:${PIECE}px}
    #aliyunCaptcha-sliding-body{position:absolute;left:0;top:${IMG_H}px;width:${IMG_W}px;height:40px;background:#333}
    #aliyunCaptcha-sliding-slider{position:absolute;left:0;top:${IMG_H}px;width:40px;height:40px;background:#0af;cursor:grab}
  </style>
  <div id="JS_aliyun-captcha-dialog">
    <div class="aliyunCaptcha-sliding-img-bg"></div>
    <div class="aliyunCaptcha-sliding-img-puzzle"></div>
    <div id="aliyunCaptcha-sliding-body"></div>
    <div id="aliyunCaptcha-sliding-slider"></div>
  </div>
  <script>
    // 1) 造一张有纹理的背景，导出 dataURL
    const bg = document.createElement('canvas');
    bg.width = ${IMG_W}; bg.height = ${IMG_H};
    const bctx = bg.getContext('2d');
    for (let y = 0; y < ${IMG_H}; y++) for (let x = 0; x < ${IMG_W}; x++) {
      bctx.fillStyle = 'rgb(' + ((x*3+y*5)%255) + ',' + ((x*7+y*2)%255) + ',' + ((x*11+y*13)%255) + ')';
      bctx.fillRect(x, y, 1, 1);
    }
    // 2) 从背景抠出缺口处的拼图块
    const piece = document.createElement('canvas');
    piece.width = ${PIECE}; piece.height = ${PIECE};
    piece.getContext('2d').drawImage(bg, ${GAP_X}, 26, ${PIECE}, ${PIECE}, 0, 0, ${PIECE}, ${PIECE});

    document.querySelector('.aliyunCaptcha-sliding-img-bg').style.backgroundImage = 'url(' + bg.toDataURL() + ')';
    document.querySelector('.aliyunCaptcha-sliding-img-puzzle').style.backgroundImage = 'url(' + piece.toDataURL() + ')';

    // 3) 滑轨交互：记录最终位移，写进 title
    const slider = document.getElementById('aliyunCaptcha-sliding-slider');
    let dragging = false, startX = 0, dx = 0;
    slider.addEventListener('mousedown', (e) => { dragging = true; startX = e.clientX; dx = 0; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      dx = e.clientX - startX;
      slider.style.left = Math.max(0, dx) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.title = 'DRAG:' + Math.round(dx);
    });
  </script>`;
}

let server;
let base;
let browser;

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

test('能定位到背景图与拼图块', async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page.waitForTimeout(300);
  const cands = await locateImages(page);
  assert.ok(cands.length >= 2, `应至少找到两张图，实际 ${cands.length}`);
  const classes = cands.map((c) => c.cls).join('|');
  assert.match(classes, /sliding-img-bg/);
  assert.match(classes, /sliding-img-puzzle/);
  await page.close();
});

test('端到端：解出缺口并拖动到正确距离', async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page.waitForTimeout(300);

  const logs = [];
  const r = await solveAndDrag(page, { log: (m) => logs.push(m) });
  assert.equal(r.ok, true, `应求解成功：${r.reason || ''}`);
  // 块图是干净裁剪（无透明边），所以 offset 就等于缺口 x
  assert.ok(Math.abs(r.offset - GAP_X) <= 2, `offset 期望 ≈${GAP_X}，实际 ${r.offset}`);
  assert.ok(Math.abs(r.distance - GAP_X) <= 2, `distance 期望 ≈${GAP_X}，实际 ${r.distance}`);

  await page.waitForTimeout(300);
  const title = await page.title();
  const m = /DRAG:(-?\d+)/.exec(title);
  assert.ok(m, `页面应记录拖动距离，实际 title=${title}`);
  const recorded = Number(m[1]);
  assert.ok(Math.abs(recorded - GAP_X) <= 3, `实际拖动 ${recorded}px，期望 ≈${GAP_X}px`);
  assert.ok(logs.some((l) => l.step === 'solved'), '应有求解日志');
  await page.close();
});

test('没有验证码元素时安全失败，不抛异常', async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(() => document.querySelector('#JS_aliyun-captcha-dialog').remove());
  const r = await solveAndDrag(page);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
  await page.close();
});
