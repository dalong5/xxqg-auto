// 「拖到最右边」型验证码：不需要图像，纯几何求解
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { detectCaptchaKind, solveAndDrag, solveSlideToEnd } from '../src/domain/captcha/aliyun.js';

const TRACK_W = 320;
const HANDLE_W = 40;

/** 模拟阿里云「请按住滑块，拖动到最右边」皮肤：无拼图块，只有手柄 + 文案 */
function html() {
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#111;color:#fff}
    #JS_aliyun-captcha-dialog{position:absolute;left:40px;top:40px;width:${TRACK_W}px}
    #aliyunCaptcha-sliding-body{position:relative;width:${TRACK_W}px;height:44px;background:#fff;color:#333;display:flex;align-items:center}
    #aliyunCaptcha-sliding-slider{position:absolute;left:0;top:0;width:${HANDLE_W}px;height:44px;background:#0af;cursor:grab}
    .tip{margin-left:${HANDLE_W + 8}px;font-size:13px}
  </style>
  <div id="JS_aliyun-captcha-dialog">
    <div id="aliyunCaptcha-sliding-body">
      <span class="tip">请按住滑块，拖动到最右边</span>
      <div id="aliyunCaptcha-sliding-slider"></div>
    </div>
  </div>
  <script>
    const track = document.getElementById('aliyunCaptcha-sliding-body');
    const slider = document.getElementById('aliyunCaptcha-sliding-slider');
    let dragging = false, startX = 0, dx = 0;
    slider.addEventListener('mousedown', e => { dragging = true; startX = e.clientX; });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      dx = Math.max(0, Math.min(${TRACK_W - HANDLE_W}, e.clientX - startX));
      slider.style.left = dx + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.title = 'DRAG:' + Math.round(dx) + '/' + (${TRACK_W} - ${HANDLE_W});
    });
  </script>`;
}

let server;
let base;
let browser;

before(async () => {
  server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

test('能识别为 slide-to-end（无拼图块 + 最右文案）', async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const kind = await detectCaptchaKind(page);
  assert.equal(kind, 'slide-to-end');
  await page.close();
});

test('距离 = 轨道右缘 − 手柄中心，且页面记录到达终点', async () => {
  const page = await browser.newPage();
  await page.goto(base);
  const r = await solveAndDrag(page, { log: () => {} });
  assert.equal(r.ok, true, r.reason || '');
  assert.equal(r.kind, 'slide-to-end');
  // 手柄中心起点 = 20，轨道右缘 = 320 → 期望 ~298（留 2px 余量）
  assert.ok(Math.abs(r.distance - (TRACK_W - HANDLE_W / 2 - 2)) <= 3, `distance=${r.distance}`);
  await page.waitForTimeout(250);
  const title = await page.title();
  const m = /DRAG:(\d+)\/(\d+)/.exec(title);
  assert.ok(m, `页面应记录拖动结果，实际 ${title}`);
  assert.equal(Number(m[2]), TRACK_W - HANDLE_W);
  assert.ok(Number(m[1]) >= TRACK_W - HANDLE_W - 2, `实际拖动 ${m[1]}，应到 ${TRACK_W - HANDLE_W}`);
  await page.close();
});

test('没有滑块元素时快速失败（不空等）', async () => {
  const page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(() => document.querySelector('#JS_aliyun-captcha-dialog').remove());
  const t0 = Date.now();
  const r = await solveSlideToEnd(page);
  const ms = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.ok(ms < 5000, `应在 5s 内返回，实际 ${ms}ms`);
  await page.close();
});
