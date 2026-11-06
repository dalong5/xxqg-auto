/**
 * 操作系统级鼠标输入（真实输入栈，非 CDP 合成事件）。
 *
 * 为什么需要它：阿里云滑块会把 CDP 合成拖动判成自动化（F001），
 * 历史上唯一通过过的组合是「原生浏览器 + OS 输入」。
 *
 *   Windows : scripts/native.ps1 → SendInput
 *   Linux   : xdotool → XTest（需要 DISPLAY，容器里用 Xvfb）
 */
import { execFile } from 'node:child_process';

/** 页面几何 + 屏幕缩放 → 操作系统鼠标坐标 */
export function screenPoint(geo, cssX, cssY) {
  // Windows 高 DPI：screenX/screenY 是 CSS px，SendInput 要物理 px
  // Linux(X11/Xvfb)：无缩放，窗口无 WM 装饰
  const scale = process.platform === 'win32' && geo.d >= 1.5 ? 2 : 1;
  const oy = geo.sy * scale + geo.oh * scale - geo.ih * geo.d;
  const ox = geo.sx * scale + (geo.ow * scale - geo.iw * geo.d) / 2;
  return { x: Math.round(ox + cssX * geo.d), y: Math.round(oy + cssY * geo.d) };
}

/** 读取页面几何（窗口在屏幕上的位置、外框尺寸、缩放） */
export async function pageGeometry(page) {
  return page
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
}

/** Windows：SendInput，走 native.ps1 的 drag 动作 */
export function dragWin32(x1, y1, x2, y2, steps = 34) {
  return new Promise((res, rej) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/native.ps1',
        '-Action', 'drag',
        '-A1', String(x1), '-A2', String(y1),
        '-A3', String(x2), '-A4', String(y2),
        '-A5', String(steps),
      ],
      { cwd: process.cwd(), timeout: 40_000 },
      (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out)),
    );
  });
}

/** Linux：xdotool 链式命令，一次进程内完成按下→分段移动→松开 */
export function dragX11(x1, y1, x2, y2, steps = 30) {
  const display = process.env.DISPLAY || ':99';
  const parts = ['mousemove --sync', String(x1), String(y1), 'sleep 0.12', 'mousedown 1', 'sleep 0.06'];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3); // 先快后慢
    parts.push('mousemove --sync', String(Math.round(x1 + (x2 - x1) * eased)), String(Math.round(y1)), 'sleep 0.02');
  }
  parts.push('mousemove --sync', String(x2), String(y2), 'sleep 0.08', 'mouseup 1');
  return new Promise((res, rej) => {
    execFile(
      'xdotool',
      parts,
      { env: { ...process.env, DISPLAY: display }, timeout: 40_000 },
      (e, out, err) => (e ? rej(new Error(`xdotool: ${(err || e.message).trim().slice(0, 200)}`)) : res(out)),
    );
  });
}

/** 本机是否具备真实输入能力（无桌面/无 DISPLAY 时返回 false） */
export function osInputAvailable() {
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return !!process.env.DISPLAY;
  return false;
}

/** 从手柄中心拖 distanceCss（CSS px）过去；返回实际使用的屏幕坐标 */
export async function dragSliderBy(page, handle, distanceCss, { steps } = {}) {
  if (!osInputAvailable()) throw new Error('当前环境没有可用的 OS 输入通道');
  const geo = await pageGeometry(page);
  if (!geo) throw new Error('读不到页面几何');
  const from = screenPoint(geo, handle.x + handle.width / 2, handle.y + handle.height / 2);
  const to = { x: Math.round(from.x + distanceCss * geo.d), y: from.y };
  if (process.platform === 'win32') await dragWin32(from.x, from.y, to.x, to.y, steps ?? 34);
  else await dragX11(from.x, from.y, to.x, to.y, steps ?? 30);
  return { from, to, geo };
}
