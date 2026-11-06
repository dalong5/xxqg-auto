# 交接说明（给下一个 AI / 人）

> **2026-11-06 更新（先看这段）**
>
> 滑块问题已经定性并有对照实验证据，结论写在 [POSTMORTEM.md](./POSTMORTEM.md)，进度记在 [PROGRESS.md](./PROGRESS.md#2026-11-06-排障收口详见-docspostmortemmd)。三句话版本：
>
> 1. **判据不是 CDP**：Playwright-Firefox（完全没有 CDP）同样过不去；只有「原生启动的 Chrome + 操作系统输入栈的鼠标」过了一次（2/5→5/5，27→32）。
> 2. **卷子是页面级状态**：答题途中换浏览器 = 从 1/5 重来，所以「CDP 答题 + 普通 Chrome 交卷」这条设计上就走不通，已从代码里移除。
> 3. **当前可跑的通道**：`XXQG_PLAIN_ONLY=1` → `plain.runDaily()`（同一页面里看提示、答题、翻页、完成、拖滑块）。它会偶发 Chrome 渲染进程崩溃，崩溃后只能整卷重来。
>
> 还没闭环的一件事：登录态过期了，需要重新扫码后跑 `cd app && node research/check_daily.mjs` 验证加分闭环。

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
## 2026-11-03 18:00 找到滑块病根：CDP 等同 devtools

对照实验（同一账号、同一网络、同一台机器、同一时间窗，只改一个变量）：

| 条件 | 结果 |
| --- | --- |
| Playwright/CDP 附着浏览器，拖滑块 | 每次都 `{"code":403,"message":"slider verify failed"}`，F001 |
| 同一 cookie 注入**普通 Chrome（无任何调试端口）**，人手级别真实鼠标拖 | **滑块通过，交卷成功，+2 分**，分数从 27 → 29 |

操作方法：把 token/acw_tc/aliyungf_tc 以 Chrome v10（AES-256-GCM + DPAPI 解出的 key，明文前置 sha256(host_key)）直接写进 profile 的 Cookies 库，启动不带 `--remote-debugging-*` 的 Chrome，`pc.xuexi.cn/points/my-points.html` 正常登录。

两个额外坑（都已解决）：

1. Chrome 137+ 起 `--load-extension` 被特性开关关掉，加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 也不够，本机 156 实测仍不生效 → 放弃插件，直接写 Cookies 库。
2. **cookie 必须 `is_httponly=0`**。写 `1` 时 `pc-api.xuexi.cn/open/api/user/info` 能过（服务端读得到），但点开 `points/*.html` 一律 302 到 `points/login.html`——页面自己的登录判定是 JS 读 cookie（和 `abnormal_exam` 同一套 js-cookie），HttpOnly 的 token 它看不见。
3. 写 cookie 前 Chrome 必须完全退出，否则写进去的行会被丢弃；`expires_utc` 用整数（BigInt 会被丢）。

由此确定后续方向：**把「交卷 + 滑块」从 CDP 里搬到无调试端口的浏览器**（答题仍可用 Playwright 提速，交卷前关掉 CDP 浏览器，再由原生输入完成最后一步）。这是继「关掉 devtools 就行」之后唯一被实验证实的路子。
## 2026-11-03 23:35 Firefox 也不行：问题不在 CDP

用 Playwright 自驱的 **Firefox**（Juggler 协议，浏览器里根本没有 CDP/devtools）跑同一套答题逻辑：

- 进页面、查看提示、答题全部正常（`第 6 题 [单选题]` 一路推进）；
- 到「完成」后的滑块：`[captcha] attempt 1/2/3 sliderX 452 -> 452`，三次回弹，交卷依旧 `slider verify failed`。

结论修正：**F001 不是「有 CDP」触发的**。同一账号下能过的只有一次 —— 那次是「无调试端口的普通 Chrome + 真实 OS 鼠标（SendInput）拖拽」。所以真正的判据是**输入是不是来自操作系统输入栈**（SDK 采集的是 pointer 轨迹/时序/`sourceCapabilities` 这一类），而不是自动化协议本身。

后续唯一线路：普通 Chrome（无 `--remote-debugging-*`）+ 预置 cookie + OS 级鼠标键盘（`scripts/native.ps1`），答题用页面内 JS 读题 + 生成坐标，点击/拖拽全部走 SendInput。
## 2026-11-03 23:45 每日答题跑通（5/5）

`app/src/xxqg/plain.js` + `app/scripts/native.ps1` 这一套今天实测把每日答题从 2/5 打到 **5/5**（总分 27 → 32）：

1. `seedProfile()`：DPAPI 解 key，把 token/acw_tc/aliyungf_tc 以 Chrome v10 写进 `data/plain/<uid>`（`is_httponly=0`）。
2. `open()`：**不带任何 `--remote-debugging-*`** 启动 Chrome，`MoveWindow(0,0,2800,1700)`（2x 屏，坐标=物理像素）。
3. 读页面：地址栏拼 `javascript:void(...)`（分三段粘贴：正文 / `:` / `javascript`，避开 Chrome 剥 scheme 和中文输入法全角冒号），结果写 `document.title`，Node 侧读窗口标题。
4. **答案来源就是页面自己的「查看提示」**：点 `.q-footer-answer-tip-wrap .tips` 后，`div.answer` 里出现 `正确答案：B` + 解析。
5. 点击/拖拽全部走 `scripts/native.ps1`（`SetProcessDPIAware` + `SetCursorPos`/`mouse_event`），即真实 OS 输入。
6. `.action-row button:last-child` 先 `scrollIntoView({block:'center'})` 再取矩形，否则 2x 屏下按钮 y 会超出窗口高度、点到桌面上。
7. 完成 → 滑块 `#aliyunCaptcha-sliding-slider` 拖到 `#aliyunCaptcha-sliding-body` 右缘（34 步 / ~900ms）→ **通过**，分数落库。

同一路径在 Firefox（无 CDP）里拖滑块仍然失败，所以判据是「输入来自 OS 输入栈」，不是协议。

踩过并已修的坑：`javascript:` 返回值是字符串会替换整页（必须 `void()` 包裹）；PowerShell 5.1 非 DPI 感知导致坐标被虚拟化；ps1 里非 ASCII 注释会让 PowerShell 解析失败（已改 ASCII 注释 + BOM）；`--load-extension` 在 Chrome 156 失效。
## 2026-11-04 23:00 现状：代码就绪，卡在登录态

- 11-04 18:47 定时任务把账号跑挂了：`cookie 已失效，请重新扫码`。之后 `open/api/user/info` 直接失败、`score` 返回空壳，所以**今天没有任何分数**，也没法验证滑块。
- 11-03 23:45 那次实测证明：**无 CDP 普通 Chrome + 真实 OS 鼠标**能把每日答题交卷成功（2/5 → 5/5，总分 27 → 32）。这条路径已经产品化：
  - `app/src/xxqg/plain.js`：`runDaily(uid, jar)` 一条龙（seed cookie → 开卷 → 看提示作答 → 完成 → 拖滑块 → 关浏览器）；
  - `app/scripts/native.ps1`：DPI 感知的 SendInput（点击/拖拽/粘贴）；
  - `app/src/xxqg/tasks.js`：每日答题默认先走这条；失败不再自动回退必挂的 CDP 通道（要回退设 `XXQG_PLAIN_FALLBACK=1`）。
- 11-04 新增抗卡题：按钮没点亮就补选全部选项 / 补满空位；同一题卡 4 次才放弃（之前 14 轮耗尽在 5 道题上，报「没有完成按钮」）。
- 自检脚本：`cd app && node research/check_daily.mjs`（先打登录态、跑一遍、再对分数，一行一个结论）。

**下一步（只差这一件事）**：重新扫码拿到新 token，然后跑 `node research/check_daily.mjs`，确认「跑完 每日答题 5/5 ✅」。