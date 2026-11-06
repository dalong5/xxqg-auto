/**
 * Xvfb / 真实桌面自检：验证「OS 级鼠标」真的能把滑块拖到终点。
 *
 * 同一份脚本两个平台都跑得通：
 *   Windows        → SendInput (scripts/native.ps1)
 *   Linux + Xvfb   → xdotool (XTest)，需要 DISPLAY
 *
 * 用法：
 *   node deploy/xvfb-selftest.mjs            # 复用当前 DISPLAY（Linux）或桌面（Windows）
 *   node deploy/xvfb-selftest.mjs --xvfb     # 自己拉起 Xvfb :99（仅 Linux + 已装 xvfb）
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';
import { dragSliderBy, osInputAvailable } from '../src/xxqg/osinput.js';

const TRACK = 320;
const HANDLE = 40;
const PAGE = `<!doctype html><meta charset="utf-8"><title>captcha-selftest</title><style>
  body{margin:0;background:#111;color:#fff}
  #JS_aliyun-captcha-dialog{position:absolute;left:40px;top:40px;width:${TRACK}px}
  #aliyunCaptcha-sliding-body{position:relative;width:${TRACK}px;height:44px;background:#fff;color:#333;display:flex;align-items:center}
  #aliyunCaptcha-sliding-slider{position:absolute;left:0;top:0;width:${HANDLE}px;height:44px;background:#0af;cursor:grab}
  .tip{margin-left:${HANDLE + 8}px;font-size:13px}
</style>
<div id="JS_aliyun-captcha-dialog">
  <div id="aliyunCaptcha-sliding-body">
    <span class="tip">请按住滑块，拖动到最右边</span>
    <div id="aliyunCaptcha-sliding-slider"></div>
  </div>
</div>
<script>
  const slider = document.getElementById('aliyunCaptcha-sliding-slider');
  let dragging = false, startX = 0;
  window.__drag = null;
  slider.addEventListener('mousedown', e => { dragging = true; startX = e.clientX; window.__trusted = e.isTrusted; });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = Math.max(0, Math.min(${TRACK - HANDLE}, e.clientX - startX));
    slider.style.left = dx + 'px';
    window.__drag = Math.round(dx);
  });
  window.addEventListener('mouseup', () => { dragging = false; });
</script>`;

function startXvfb() {
  const p = spawn('Xvfb', [':99', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: true });
  p.unref();
  process.env.DISPLAY = ':99';
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const useXvfb = process.argv.includes('--xvfb');
  if (useXvfb) {
    startXvfb();
    console.log('Xvfb :99 已启动');
    await sleep(1200);
  }
  if (!osInputAvailable()) {
    console.error('当前环境没有 OS 输入通道（Windows 桌面，或 Linux 需要 DISPLAY）');
    process.exit(2);
  }

  const server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'chrome' : undefined,
    headless: false,
    args: ['--no-sandbox', '--window-position=0,0', '--window-size=1000,700'],
  });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(800);

  const handle = await page.locator('#aliyunCaptcha-sliding-slider').boundingBox();
  const track = await page.locator('#aliyunCaptcha-sliding-body').boundingBox();
  const distance = Math.round(track.x + track.width - (handle.x + handle.width / 2) - 2);
  console.log(`几何：track=${Math.round(track.width)} handle=${Math.round(handle.width)} 目标距离=${distance}`);

  const { from, to, fix } = await dragSliderBy(page, handle, distance, { steps: 28 });
  console.log(`校准：修正偏移 dx=${fix.x}px dy=${fix.y}px（页面回报的位置 vs 换算位置）`);
  console.log(`输入：(${from.x},${from.y}) → (${to.x},${to.y}) via ${process.platform === 'win32' ? 'SendInput' : 'xdotool'}`);
  await page.waitForTimeout(600);

  const result = await page.evaluate(() => ({ drag: window.__drag, trusted: window.__trusted }));
  const expected = TRACK - HANDLE;
  const ok = typeof result.drag === 'number' && Math.abs(result.drag - expected) <= 3;

  console.log(`结果：页面记录拖动=${result.drag}（期望 ${expected}），isTrusted=${result.trusted}`);
  await browser.close();
  await new Promise((r) => server.close(r));

  if (!ok) {
    console.error('FAIL：OS 鼠标没有把滑块拖到终点');
    process.exit(1);
  }
  console.log('PASS：OS 级输入到达页面并拖到终点');
}

main().catch((e) => {
  console.error('自检异常：', e.message);
  process.exit(1);
});
