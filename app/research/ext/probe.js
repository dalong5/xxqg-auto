// 把滑块几何 + 页面状态报到本机，供外部真实鼠标定位
const post = async () => {
  const s = document.querySelector('#aliyunCaptcha-sliding-slider');
  const d = document.querySelector('#aliyunCaptcha-sliding-dialog, #JS_aliyun-captcha-dialog');
  const box = s ? s.getBoundingClientRect() : null;
  const body = document.querySelector('#aliyunCaptcha-sliding-body');
  const path = document.querySelector('.aliyunCaptcha-sliding-path, #aliyunCaptcha-sliding-panel');
  const fin = [...document.querySelectorAll('.action-row button')].map((b) => b.innerText.trim()).join('|');
  await fetch('http://127.0.0.1:8099/api/dev/geom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      at: Date.now(),
      innerW: innerWidth,
      innerH: innerHeight,
      dpr: devicePixelRatio,
      ua: navigator.userAgent,
      logged: !document.body.innerText.includes('扫码登录') && !location.pathname.includes('login'),
      dialog: Boolean(d),
      bodyW: body ? body.getBoundingClientRect().width : 0,
      pathW: path ? path.getBoundingClientRect().width : 0,
      slider: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
      buttons: fin,
      q: document.querySelectorAll('.q-body').length,
    }),
  }).catch(() => {});
};
setInterval(post, 1500);
post();