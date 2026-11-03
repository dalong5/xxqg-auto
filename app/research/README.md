# research/ —— 一次攻坚留下的实物证据

这个目录是「每日/每周/专项答题交卷被阿里云滑块卡死」这件事的全部现场。**别删**，接手的人靠它复现。

## 目录

- `probe_mv3.mjs` / `probe_wd.mjs` / `probe_st.mjs` / `probe_focus.mjs` / `probe_dpr.mjs` / `probe_tz.mjs`：同一个壳，答题答到「完 成」→ 出现滑块 → 用不同姿势拖动（步数/时长/起止点/DPR/时区/webdriver/焦点）。**这是主力复现脚本，改一处跑一次。**
- `probe_len3.mjs`：抓 `VerifyCaptchaV3` 的 `data` 密文长度，证明轨迹确实上报（0 步 372B，60 步 720B）。
- `probe_capx.mjs` / `probe_dec2.mjs`：抓并解码 `InitCaptchaV3` / `VerifyCaptchaV3` 的真实请求与响应（能看到 `VerifyCode: F001`）。
- `probe_dummy2.mjs`：把 `window.initAliyunCaptcha` 打成桩，让页面带着假 `captchaVerifyParam` 把**真实交卷载荷**发出去，服务端回 `403 slider verify failed`。
- `probe_nock.mjs`：删 `abnormal_exam` cookie 后直接交卷 → 客户端不弹滑块、服务端仍 403。
- `probe_nocap.mjs` / `probe_get.mjs` / `probe_ck2.mjs`：追 `abnormal_exam` 是谁写的（结论：阿里云 fp 写的 cookie，不是 sessionStorage）。
- `probe_native.mjs`：原生 Chrome（`--remote-debugging-port`）+ `connectOverCDP`，排除 Playwright 启动参数。
- `probe_hold.mjs`：有头浏览器停在滑块那一步不关，配合操作系统级真实鼠标拖（见 `docs/HANDOFF.md` 的 cua 用法）。
- `probe_px3.mjs` / `probe_px4.mjs` / `px.txt`：中国出口代理可用性筛选 + 走代理再试滑块。
- `probe_env.mjs` / `probe_fp.mjs` / `probe_ev.mjs` / `probe_mv7.mjs` / `probe_mv8.mjs`：环境自证（WebGL 是真 AMD 卡、canvas 稳定、指针事件字段齐全且 `movementX` 正常、fp cookie 稳定）。
- `probe_risk.mjs` / `probe_dr*.mjs` / `probe_sc.mjs`：找风险判定入口（页面根本没有 `detectRisk` 调用，`abnormal_exam` 由 fp 直接写）。
- `fl.js` `fl6.js` `fp.js`：从 CDN 拉下来的阿里云 `FeiLin` / `aliyunFP` 打包产物，已确认里面**没有** `webdriver` / `isTrusted` / `pointerdown` 字样，靠 `addEventListener` 通用收集。
- `examp.js`：答题页业务包，交卷接口、`abnormal_exam` 判断、`SceneId: 4lku1m5p` 都在这里。
- `*.log`：各轮实测输出（`cap*` 滑块、`js*` 交卷、`hum*` 拟人拖动、`trace*` 载荷长度、`px*` 代理）。
- `misc/`：早期登录/接口/UI 探针。

## 跑之前

1. 需要已登录账号的 cookie（`app/data/app.db` 的 `logins.jar`，脚本会自动读最新一条）。
2. 需要 `danger-full-access`（Chromium 走 Mojo 管道）。
3. 跑法：`node probe_mv3.mjs`（约 2 分钟，会把当天那套题答完再拖滑块）。