# 仓库约定（给 agent 看）

学习强国「扫码登录 + 自动做任务」站点。多账号界面与服务器部署已实现，仍需人工处理安全验证；多人长期运行未验证。

> 最新状态：每日答题已真实完成，今日 32 分；APP 专属任务尚无浏览器执行能力。长期可靠性仍需跨天观察。

> 接手先读 `docs/HANDOFF.md`（现状、唯一卡点、试过什么、下一步）和 `app/research/README.md`（现场证据怎么复现）。

## 目录

```
app/                 可运行代码（Node 24 + Express + Playwright）
  src/
    server.js        API 进程：访客会话、扫码、账号、入队、SSE
    worker.js        执行器进程：领任务、开浏览器、写事件
    db.js            SQLite（WAL）：visitors/users/logins/jobs/events/workers
    loginflow.js     扫码状态机
    auth.js          签名访客 cookie + 限流
    crypto.js        cookie 的 AES-256-GCM 封存
    xxqg/client.js   全部 HTTP 协议 + CookieJar
    xxqg/browser.js  浏览器池、反检测、拟人停留
    xxqg/tasks.js    阅读 / 视听 / 答题
  public/index.html  单账号界面
docs/                方案、协议、进度
```

## 起服务

```bash
cd app && npm install
copy .env.example .env      # 改 APP_SECRET
npm run dev                 # API + worker
```

Windows+Dsh 沙箱下 Chromium 需要命名管道 → 必须 `danger-full-access`。

## 铁律

1. **登录走 HTTP，任务走浏览器。** 阅读/视听的分是页面内 SDK 按停留上报的，纯接口伪造不了。
2. **分数是唯一真相。** 每步都回查 `listScoreProgress`，到 `dayMaxScore` 就停；上限不许写死。
3. **不许盲刷。** 每完成一条必须 `refresh()` 再决定是否继续。
4. **防封号优先于快。** 停留 60s+ 且带浮动、页面内鼠标移动、任务间停 15~45s、同账号串行、复用设备态（`data/profiles`）。
5. **cookie 当密码。** AES-256-GCM 落盘，密钥在 `data/secret.key`（原子创建，绝不覆盖）。
6. **密钥变了要能自愈。** `logins.jar` 保存 7 天明文，解密失败自动从那里恢复。
7. **分数不回退。** 同一天只接受更高的 total，防并发旧快照覆盖。
8. **事件即日志。** 一切进度写 `events` 表，前端用 SSE 读；不要只在 stdout 打。

## 已知坑

- 每日/每周/专项答题的入口是 `.my-points-card` 里的「去答题」，不是标题文字。
- 视频页 `autoplay=false`，必须 `video.muted=true` 再 `play()`，否则一秒都不计。
- 浏览器被 `kill` 后 `running` 任务靠 worker 心跳回收，别用超时盲扫。
- 答题出现「点选填空」时 `input` 数量为 0，要按词块点击（见 `docs/PROTOCOL.md`）。
- 提速后 wpm 容易爆：`WORKER_CONCURRENCY` 每加 1 约 +300MB。
