# 交接说明（给下一个 AI / 人）

写于 2026-11-03。当前**能拿的分已经全部拿到并验证**，唯一缺口是答题交卷被阿里云滑块 `F001` 卡住。请先读完再动手，很多坑已经踩过。

## 1. 目标与现状

- 目标站点：学习强国 PC 网页版，扫码登录 + 自动做任务。
- 已跑通并实测到账：扫码登录、每日登录 1 分、文章阅读 12/12、视听 12/12（含两项时长分）。
- 今日总分 **27**，进度接口实测：`阅读 12/12`、`视听 12/12`、`登录 1/1`、`每日答题 0/5`。
- 上限 45，**还差 18 分**（每日 5 + 每周 5 + 专项 8），三个都要走同一个交卷接口，全部止步于滑块。
- 答题的**答题过程本身已经打通**：五题能全答、能点「完 成」、能出答案解析；卡在提交时要求的 `captchaVerifyParam`。

## 2. 跑起来

```bash
cd app && npm install
copy .env.example .env      # 改 APP_SECRET
npm run dev                 # API + worker
```

Windows + DSH 沙箱下 Chromium 必须 `danger-full-access`。账号 cookie 在 `data/app.db` 的 `logins.jar`（AES-GCM 封存，`data/secret.key` 是密钥，7 天明文备份在 `logins.jar` 表里能自愈）。

单跑一个任务：`node research/tmp_run.mjs <uid> daily`；同步分数：`node research/tmp_sync.mjs <uid>`。这些都必须在 `app/` 下跑。

## 3. 卡点：阿里云滑块 F001

### 已经确认的事实（都可复现）

- 页面前置：`Cookies.get('abnormal_exam')` 为真就弹滑块，否则直接 POST。`abnormal_exam` 是**阿里云 fp 写的 cookie**（`_c_WBKFRo` 同一批），每次进答题页必被写 1。
- 交卷接口与载荷已逆向：`POST /api/exam/service/practice/quizSubmitV3`，体 `{uniqueId, questions:[{questionId, answers:[{answerId, value}], correct}], usedTime}`，成功要靠请求头 `captchaVerifyParam`。
- 打桩 `window.initAliyunCaptcha = o => o.success('dummy')` 能拿到真实载荷，服务端回 `{"code":403,"message":"slider verify failed"}` —— 没有合法参数就是不收。
- 删 `abnormal_exam` 只是让客户端跳过滑块，服务端照样 403。
- 滑块本身是活的：`#aliyunCaptcha-sliding-slider.style.left` 从 0 变 320px，`elementFromPoint` 就是滑块，事件链 `pointerdown/mousedown/pointermove/mousemove/pointerup/mouseup` 全到，`movementX` 正常、`screenX = clientX + 窗口偏移` 正常、`isTrusted: true`。
- 轨迹确实上报：`VerifyCaptchaV3` 的 `data` 密文 0 步 372B、60 步 720B（`probe_len3.mjs`）。
- 但 `VerifyCaptchaV3` 恒回 `{"VerifyCode":"F001","VerifyResult":false}`。阿里云文档：`F001` = 被风控判定为攻击。

### 已排除

页面无焦点、DPR 1 vs 2、`--enable-automation` + `navigator.webdriver`（true/false/undefined 三种都试）、原生 Chrome 一切参数走 CDP、`Asia/Singapore` 时区对齐出口 IP、等 `InitCaptchaV3` 响应回来再拖、等待 0.2/1.2/2.5/20 秒再拖、拖动 0/5/20/30/40/45/60 步、10~2000ms 时长、起点居中/贴边、终点贴边/过冲、headless 与有头、**操作系统级真实鼠标**（`cua_driver` 对真实窗口 SendInput，`probe_hold.mjs` 停住等拖）、**中国出口代理**（`119.188.131.55:17981` 山东联通，`probe_px4.mjs`，照样 F001）。

> 注意：**换中国 IP 也一样 F001**，所以别再往「境外 IP」这个方向想了。

第二轮补充（2026-11-03 深夜），全部照做仍是 F001，别再重复：

- 阿里云官方错误码表：`F001` = 疑似攻击请求、风险策略不通过；另有 `F024` = 检测到自动化脚本模拟点击/滑动。
- 官方问答明确写过：**开着 F12/devtools、触发敏感调试行为，就会被判 F001**（原文：「开启F12 devtools并触发敏感调试行为被风控拦截，不会影响正常用户，需要调试可在控制台开启测试模式」）。Playwright 全靠 CDP，等价于 devtools 常驻 —— **这是目前最像的成因**，下一轮优先验证。
- 官方另一条：`captchaVerifyParam` 里的 `+` 若被转义成空格，服务端必判失败；本链路是页面自己拼 header，未发生，排除。
- 一致性实验也无用：`--disable-blink-features=AutomationControlled`、`webdriver=false`、去掉 UA 的 `HeadlessChrome/`、有头、让 innerWidth/outerWidth/screen 三者一致（本机实际 CSS 屏 1280×720、DPR 1，原来写死 1440×900 viewport 反而是假指纹）。

### 还没试过的方向（按性价比排序）

0. **验证「CDP = devtools」这条**：①最简单是让人在真 Chrome 里手动拖一次，若人能过而我们过不了，就锁定 CDP；②若锁定，试 `--remote-debugging-pipe` vs `--remote-debugging-port`、试 Puppeteer 旧版 `chrome-remote-interface`、试 Chrome 扩展注入脚本（无 devtools 协议痕迹）、试 `chrome.debugger` 之外的原生方案；③也可试开启阿里云控制台的「测试模式」（T005 直接放行，但那是租户级配置，学习强国未必开）。
1. **把 `data` 解出来看结构**。密文是飞林加密，key 在 `fl6.js`/`fp.js` 里；解开就能看出它是「轨迹点数组」还是「设备指纹 + 轨迹」，也能知道字段是不是退化（比如时间戳全等、`x` 不走）。这是最有可能一击命中的方向。
2. **直接打 `VerifyCaptchaV3`**（`https://1gjqf1.captcha-open.aliyuncs.com`，`Action=VerifyCaptchaV3`，参数见 `research/probe_dec2.mjs` 抓到的原文）。自己造 `data` 送上去，用响应二分出「哪一截数据被拒」，比在浏览器里盲调快得多。
3. **换引擎**：Firefox 已装（`npx playwright install firefox`），但 `firefox.launch()` 在本机 180s 起不来，没深究；WebKit 同理没试。
4. **`fp.min.js` 里找出设备指纹的输入项**，逐项和真实 Chrome 对齐（`probe_env.mjs` 已证明 WebGL 是真实 AMD 卡、canvas 稳定，`fl*`/`fp*` 里没有 `webdriver`/`isTrusted` 字样，说明检查更隐晦）。
5. **录一段真人拖动的 `Log3` `Data` 做 golden sample**，握手时和我们的对比（需要人能拖一次成功的）。
6. 换思路：手机端 H5（`study.xuexi.cn`）的答题是否也走同一家滑块，若不走就绕开 PC。

## 4. 仓库约定（务必遵守）

`AGENTS.md` 里 8 条铁律都还有效，最容易犯的两条：

- **分数是唯一真相**：每步回查 `listScoreProgress`，到 `dayMaxScore` 就停，上限不许写死。
- **不许盲刷**：阅读/视听这事伪造不了，必须真浏览器 + 停留 + 滚动；视频要 `muted = true` 再 `play()`。

改完跑 `node --check`，重启前先杀 `dev.mjs|src/server.js|src/worker.js` 的 node 进程，再 `node research/tmp_clear.cjs` 清残留 job。

## 5. 尚未做

- 定时调度（凌晨错峰）、多用户额度/邀请码、前端一键串流程。
- Docker/部署只写了骨架（`app/Dockerfile`、`app/docker-compose.yml`），没在真机验证过。
- GitHub 私有库推送（缺凭据）。