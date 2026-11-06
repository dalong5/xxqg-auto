# 仓库约定（给 agent 看）

## 当前上线状态（2026-11-07）

- 本地 http://127.0.0.1:8101/ 与服务器 https://1.14.105.129/ 已加载暂停/继续功能；执行器发布快照 `20261107-task-pause`，主页补丁 `20261107-red-task-controls`，本轮源码和部署记录随本次提交归档，Git 保存以提交记录为准。
- 已启用 20 个逻辑执行名额（两个执行器各 1 个，加一个 18 个），每访客绑定额度 20。各账号独立上下文，同账号未结束任务包括 queued/running/pausing/paused，不允许重复运行。服务器只有约 1.7 GiB 内存，新增执行器限制 640 MiB、1 CPU；不能当作 20 个真实浏览器容量保证。
- 每周自动计划的页面、接口和触发器已移除；旧计划全部关闭，历史表保留，旧计划任务不得恢复执行。手动“每周答题”题型保留。
- 暂停在检查点退出并关闭当前账号会话后确认，释放名额；继续会回查官方进度。未完成材料或题目可能重新进入。归属变更、完成竞争、失联恢复和平台拒绝均有回归；连续执行器中断两次后失败，不无限重新入队。
- BBR 与 fq 已开启并持久化；无需重启或新增端口。8099 仍只绑定 127.0.0.1，公网访问走 HTTPS。
- 本地完整回归 53 通过；服务器隔离容器 52 通过、1 项 Windows 跳过；两端端到端与公网 HTTPS/匿名隔离/浏览器自检通过。真实账号不用于回归测试；用户自行发起的既有任务自然结束后才替换承载它的执行器。
- 服务器 2 个账号的凭据、访客归属、登录代次及密钥与发布前基线一致；没有自动解码或绕过验证码。人工验证问题尚未实现自动通过，不承诺免验证或永不封号。
- 详细行为见 `docs/TASK-PAUSE.md`、`docs/PARALLEL-ACCOUNTS.md`，运维与回滚见 `docs/TENCENT-DEPLOYMENT.md`。下方为历史记录，以本节为准。


学习强国「扫码登录 + 自动做任务」站点。多账号界面与服务器部署已实现，仍需人工处理安全验证；多人长期运行未验证。

> 当前线上（2026-11-06）：https://1.14.105.129/ 已部署 `20261106-163811-mvp-safety` 本地工作区快照（未提交/推送）。包含本地架构重构、资源生命周期/绘制优化、验证异常传播及扫码查分失败保留暂停修复。容器 49 通过、1 项 Windows 跳过，端到端和公网自检通过；原 2 个账号仍暂停，并发 1，无新增公网端口。备份与版本见 `docs/TENCENT-DEPLOYMENT.md`。下方旧部署说明为历史状态。

> 本地架构与重构（2026-11-06）：交付入口 `docs/MVP-DELIVERY.md`。HTTP 应用在 `app/src/app.js`，`server.js` 仅负责监听和退出；本轮资源生命周期及绘制优化未提交、推送或部署。后续安全/一致性风险见 `docs/REFACTOR-REVIEW.md`。

> 后续本地测试：API 与 worker 已重启加载本地代码，新增登录查分失败不得解除验证暂停的修复，50 项回归及端到端通过；没有执行真实验证码测试。详见 `docs/VERIFICATION-RECOVERY.md`。服务器随后已更新；原 42 项交付源码包未更新。

> 最新状态（2026-11-04）：腾讯云 https://1.14.105.129/ 已部署 ef4f4da；每访客绑定 10 个、执行并发 1，支持每周自动计划及每日答题每题等待 20–60 秒。旧 Instabox 的并发 2 不是腾讯云配置。账号安全验证未彻底解决，验证失败账号暂停自动计划；后续错误传播修复本地 35 项回归通过，尚待部署。以 docs/HANDOFF.md 和 docs/TENCENT-DEPLOYMENT.md 为准。

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
  public/index.html  多账号、每周计划、日志与人工验证界面
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
