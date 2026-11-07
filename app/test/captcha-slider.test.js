// 滑块回归测试：用真实站点的 DOM 结构（id/class 一致）验证
//   1) 不会把右上角关闭按钮当成手柄
//   2) 距离 = 滑轨右缘 - 手柄右缘 + 2
//   3) 页面显示「验证通过」时判定为成功（不因弹窗节点残留而误判）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { solveSlideToEnd } from '../src/xxqg/captcha/aliyun.js';

const TRACK_W = 358;
const HANDLE_W = 40;

/** 复刻 2026-11-08 实测到的真实结构（含关闭按钮干扰项） */
function pageHtml() {
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#222}
  #JS_aliyun-captcha-main{position:absolute;left:439px;top:317px;width:374px;height:174px;background:#fff}
  #JS_aliyun-captcha-logo-wrapper{position:absolute;left:8px;top:8px;width:${TRACK_W}px;height:106px;background:#e0353b}
  #JS_aliyun-captcha-close-btn{position:absolute;right:48px;top:8px;width:30px;height:30px;background:#ccc}
  #JS_aliyun-captcha-slider_bind_element{position:absolute;left:8px;top:122px;width:${TRACK_W}px;height:0}
  .aliyunCaptcha-sliding-slider{position:absolute;left:0;top:0;width:${HANDLE_W}px;height:40px;background:#0af;cursor:grab}
  .tip{position:absolute;left:${HANDLE_W + 8}px;top:14px;font-size:13px;color:#333}
  </style>
  <div id="JS_aliyun-captcha-main">
    <div id="JS_aliyun-captcha-logo-wrapper"><img id="JS_aliyun-captcha-image" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="margin:28px auto;display:block;width:40px"></div>
    <div id="JS_aliyun-captcha-close-btn">x</div>
    <div id="JS_aliyun-captcha-slider_bind_element">
      <span class="tip">请按住滑块，拖动到最右边</span>
      <div class="aliyunCaptcha-sliding-slider"></div>
    </div>
  </div>
  <script>
    const rail = document.getElementById('JS_aliyun-captcha-slider_bind_element');
    const handle = document.querySelector('.aliyunCaptcha-sliding-slider');
    const tip = document.querySelector('.tip');
    let dragging = false, startX = 0;
    handle.addEventListener('mousedown', (e) => { dragging = true; startX = e.clientX; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = Math.max(0, Math.min(${TRACK_W - HANDLE_W}, e.clientX - startX));
      handle.style.left = dx + 'px';
      if (dx >= ${TRACK_W - HANDLE_W} - 2) {
        // 真实站点通过后的样子：文案变成「验证通过!」，弹窗节点仍在
        tip.textContent = '验证通过!';
      }
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  </script>`;
}

let server;
let base;

test.before(async () => {
  server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});

test.after(async () => {
  await new Promise((r) => server?.close(r));
});

test('真实结构下滑块能一次拖过，且不会把关闭按钮当手柄', async () => {
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(base);
    await page.waitForTimeout(300);

    const logs = [];
    const r = await solveSlideToEnd(page, { log: (m) => logs.push(m) });
    const plan = logs.find((l) => l.step === 'plan');
    const attempt = logs.find((l) => l.step === 'attempt');

    assert.ok(plan, '应输出 plan 日志');
    // 距离必须是「滑轨右缘 - 手柄右缘 + 2」= 358 - 40 + 2 = 320（允许 ±2 取整误差）
    assert.ok(Math.abs(plan.distance - (TRACK_W - HANDLE_W + 2)) <= 2, `距离异常：${plan.distance}`);
    assert.ok(plan.distance > 300, `距离不应是关闭按钮算出来的小值：${plan.distance}`);
    assert.equal(r.ok, true, r.reason || '应判定成功');
    assert.equal(attempt.passed, true, '页面出现「验证通过」时 passed 应为 true');
  } finally {
    await browser.close();
  }
});
