import { chromium } from 'playwright';
for (const headless of [true, false]) {
  const b = await chromium.launch({ channel: 'chrome', headless });
  const p = await (await b.newContext()).newPage();
  const r = await p.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    let renderer = 'none';
    if (gl) { const ext = gl.getExtension('WEBGL_debug_renderer_info'); renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }
    const c2 = document.createElement('canvas'); c2.width = 200; c2.height = 40;
    const ctx2 = c2.getContext('2d'); ctx2.font = '16px Arial'; ctx2.fillText('hello', 4, 24);
    return { renderer, canvasLen: c2.toDataURL().length, au: typeof AudioContext, dpr: devicePixelRatio, hc: navigator.hardwareConcurrency, mem: navigator.deviceMemory };
  });
  console.log(headless ? 'headless' : 'headed', JSON.stringify(r));
  await b.close();
}