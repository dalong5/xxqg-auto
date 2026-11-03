# 强国助手 · 单账号测试版

一个能自己跑起来的学习强国自动签到 / 做任务站点。**先按一个人用做，跑通再开放给别人。**

- 登录：手机 APP 扫码，服务端走真实 OAuth 协议换 cookie，不碰你的密码
- 任务：真实浏览器打开文章 / 视频 / 答题页，按页面规则停留、滚动、提交
- 积分：从官方进度接口回查，一项一项盯着做，到上限就停

---

## 1. 三分钟跑起来（本机）

```bash
cd app
npm install
copy .env.example .env      # 改掉 APP_SECRET
npm run dev                 # 同时起 API(8099) + worker
```

打开 `http://127.0.0.1:8099`，按这个顺序验证：

| 步骤 | 点哪里 | 预期 |
| --- | --- | --- |
| 1 | 右上角圆点 | 变绿说明 worker 在跑；红点表示只有接口没有执行器 |
| 2 | 「浏览器自检」 | 日志出现 `HTTP 200 … sso true … qr 1`，最后「任务结束」 |
| 3 | 「生成登录二维码」 | 出二维码，手机 APP 扫 → 手机上确认 → 提示登录成功，顶部出现昵称和今日分 |
| 4 | 「查当前积分」 | 八项进度条刷新，能对上 APP 里看到的分数 |
| 5 | 「只阅读」 | 日志逐篇打印，进度条一格格涨，到 6 分自己停 |
| 6 | 「只答题」 | 逐题取「查看提示」作答，最后交卷 |

自检不需要账号，第 2 步过不了就别往下走，先查网络/Chrome。

命令行也能单独验登录，方便排查：

```bash
npm run cli      # 终端出二维码，扫完打印昵称和今日分，不进网页
```

> 在 DSH 沙箱里跑：Chromium 要建 Mojo 命名管道，`workspace-write` 模式会 `EPERM`，得用 `danger-full-access`。Docker 里没这问题。

---

## 2. 跑通之后，怎么给别人用

代码已经是「接口」和「执行器」两个进程，状态全在 SQLite，所以扩多人不用重写：

| 事项 | 单人默认 | 开放时怎么改 |
| --- | --- | --- |
| 账号数 | `MAX_ACCOUNTS=1` | 调到 3~5，或加邀请码 |
| 并发 | `WORKER_CONCURRENCY=1` | 按机器加，`worker` 容器加副本即可（`deploy.replicas`） |
| 扫码并发 | `LOGIN_CONCURRENCY=30` | 扫码只走 HTTP，几十路没压力 |
| 数据 | `data/app.db` 单文件 | 上量换 Postgres，把 `src/db.js` 的 SQL 迁过去即可 |
| 限流 | 单进程内存 12 次/分/IP | 多实例换 Redis |
| HTTPS | 无 | Nginx 反代 + 证书，SSE 要 `proxy_buffering off` |

部署（容器里 `api` 和 `worker` 分开，worker 崩了不影响别人扫码）：

```bash
copy app\.env.example app\.env    # 填 APP_SECRET
docker compose -f app/docker-compose.yml up -d --build
```

调度：`0 3 * * *` 给所有未失效账号排队（`POST /api/users/:uid/run`）。错峰很重要，别让大家 9 点一起点。

多人同时扫码时，每个人一个签名 cookie 的访客会话，只看得到自己的账号；三个会话同时生成二维码、互不串号，这一点已实测。

---

## 3. 协议（2026-11 实测，非抄旧文）

### 3.1 扫码登录

| 步 | 请求 | 返回 |
| --- | --- | --- |
| 1 | `GET https://pc-api.xuexi.cn/open/api/sns/sign` | `{data:{sign}}`，当 OAuth state |
| 2 | `GET https://login.xuexi.cn/user/qrcode/generate` | `{result:"qr:UUID"}` |
| 3 | 渲染 `https://login.xuexi.cn/login/qrcommit?showmenu=false&code=<result>&appId=dingoankubyrfkttorhpou` | 这就是 APP 扫到的东西 |
| 4 | `POST https://login.xuexi.cn/login/login_with_qr`，form `qrCode=&goto=https://oa.xuexi.cn&pdmToken=` | `11021` 待扫 / `11019` 过期 / `success` 带 `loginTmpCode` |
| 5 | `GET https://pc-api.xuexi.cn/login/secure_check?code=<loginTmpCode>&state=<sign>` | Set-Cookie 写入登录态 |
| 6 | `GET https://pc-api.xuexi.cn/open/api/user/info` | `{uid, nick}` |

### 3.2 积分

`/delegate/score/get`（总分）、`/delegate/score/today/query`（今日）、`/delegate/score/days/listScoreProgress?sence=score&deviceType=2`（每项进度）

进度里 `taskCode` 对应：`1` 阅读文章、`2` 视听学习、`9` 每日登录、`1002` 文章时长、`1003` 视听时长、`6` 每日答题、`5` 每周答题、`4` 专项答题。**上限读 `dayMaxScore`，不要写死。**

### 3.3 内容与答案

- 文章/视频：`https://www.xuexi.cn/lgdata/<id>.json`，单文件几千条，随机取
- 答题：题目自带「查看提示」，答案就包在 `<font>` 里，官方答案源，不用维护题库

---

## 4. 为什么这么设计

**登录不走浏览器**：三个请求就能拿到 cookie。放进浏览器等于每个扫码的人多开一个 Chromium（+200MB、+5 秒），还要处理跨域 iframe 截图。协议化后一次登录只有几 KB。

**任务必须走浏览器**：阅读/视听的分不是接口发的，是文章页里那套学习 SDK 按停留时长、滚动、可见性自己上报的。所以每篇真停留 60 秒、逐段下滑、滚到底，再回查分数确认涨了才继续。

**分数驱动而不是流程驱动**：每步都重新拉 `listScoreProgress`，够了就停。既省流量，也不给风控送人头。

**接口与执行器分开**：接口只做协议和落库（很轻），浏览器和重活全在 worker。worker 挂掉、重启、扩容都不影响别人扫码。

---

## 5. 目录

```
app/
├─ src/
│  ├─ server.js      API：会话、扫码、账号、任务入队、SSE
│  ├─ worker.js      执行器：领任务、跑浏览器、写事件
│  ├─ loginflow.js   扫码状态机（init → waiting → done/failed）
│  ├─ db.js          SQLite：visitors/users/logins/jobs/events
│  ├─ auth.js        访客签名 cookie + 限流
│  ├─ crypto.js      cookie AES-256-GCM 加解密
│  └─ xxqg/
│     ├─ client.js   全部 HTTP 协议 + CookieJar
│     ├─ browser.js  浏览器池、反检测、停留器
│     └─ tasks.js    阅读 / 视听 / 答题
├─ bin/login-cli.js  命令行扫码（排查用）
├─ public/index.html 单账号界面
├─ Dockerfile / docker-compose.yml
└─ .env.example
```

数据表：`visitors` 访客、`users` 账号（cookie 加密）、`logins` 扫码会话、`jobs` 队列、`events` 日志流。

---

## 6. 已实测 / 待你验证

已实测：

- `sns/sign` → `qrcode/generate` 返回可用 code，`login_with_qr` 正确返回 `11021`
- 二维码解码 == `qrcommit?...code=qr:UUID&appId=…`
- 页面 → 接口 → 二维码 → `<img>` 全链路；多会话并发、互不串号
- 队列 `selftest` 任务跑通（HTTP 200、授权 iframe 存在、二维码渲染），SSE 日志与结束事件正常
- 无 cookie 读别人的登录会话返回 404

待你验证（要账号）：

- 扫码 → `secure_check` 是否按预期写 cookie（`npm run cli` 先看这一步）
- 阅读/视听停留是否稳定涨分
- 答题页选择器对当前线上结构是否还准（`.q-body`、`.action-row`、`.tips`）

---

## 7. 风险与边界

- Web 端上限约 45 分；**挑战答题、四人赛、双人对战是 APP 独有**，要满分得再加模拟器（ADB/MaaFramework）或 APP 签名协议
- 页面结构、积分规则会变，选择器失效要有告警
- cookie 等于账号密码，已加密落盘；接口一 401 就判失效、要求重扫
- 非官方工具，账号安全风险自担；别用同一出口 IP 猛跑几十个号

## 8. 路线图

P0（当前）：单人跑通 → P1：持久化重试、选择器健康检查、滑块打磨 → P2：多用户额度、Postgres、定时调度 → P3：模拟器补 APP 独有分 → P4：登录本站、报表、计费
