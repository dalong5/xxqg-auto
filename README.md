> **接手先读**：`docs/HANDOFF.md`（现状 / 唯一卡点 / 试过什么 / 下一步）和 `app/research/README.md`（现场证据与复现方式）。
> 当前缺口：答题交卷被阿里云滑块 F001 拦住，其余任务已跑通（今日 27 分）。
> 账号 cookie 不在库（`data/` 已忽略），接手要重新扫码登录。

# 学习强国自动签到 / 做任务站点：方案与实现

> 运行手册在 [`app/README.md`](app/README.md)。这份文档讲**为什么这么做、协议长什么样、上线要什么**。

当前形态：**单账号测试版**（一个人先跑通），底层已经是「API + worker + 队列 + 加密存储」的多人结构，开放给别人时只改配置和并发。

---

## 1. 边界先说清

| 问题 | 结论 |
| --- | --- |
| 能做吗 | 能。扫码登录、签到、阅读、视听、每日/每周/专项答题都能自动化 |
| 一天多少分 | Web 端约 45 分，实际以接口 `dayMaxScore` 为准 |
| 能满分吗 | 不能只靠 Web。挑战答题、四人赛、双人对战、订阅/分享/评论是 APP 独有，要补得加 ADB + 模拟器或 APP 签名协议 |
| 登录 | 强国 PC 端是 APP 扫码 OAuth，协议已还原，纯 HTTP 完成，不需要浏览器 |
| 任务 | 必须真实浏览器：阅读/视听的分是页面内 SDK 按停留时长上报的 |
| 主要风险 | 反爬（滑块/指纹/headless）、二维码 2 分钟过期、cookie 约 20 天失效、单号 40~60 分钟的并发成本 |

架构一句话：**登录走协议（便宜稳），任务走浏览器（真实能计分），中间用队列和加密 cookie 串起来。**

---

## 2. 架构

```
浏览器 ──①扫码/点任务──▶ API(Express)  ──②落库──▶ SQLite(WAL)
   ▲                        │                      ▲
   └──⑤SSE 日志/分数────────┘                      │③原子领取
                                                   │
                        Worker(Playwright) ────────┘
                              │④注入 cookie、真停留、交卷
                              ▼
                        学习强国页面（自己计分）
```

- **API 进程只做轻活**：签名、二维码、状态机、入队、SSE。没有浏览器，可多副本。
- **Worker 进程干重活**：领任务、开隔离上下文、跑页面。崩了重启不影响别人扫码。
- **任务用 DB 原子领取**（`UPDATE … RETURNING`），多 worker 不会重复跑同一单。
- **登录和任务分两个池**：登录只走 HTTP，`LOGIN_CONCURRENCY=30`；任务受内存限制，默认 1。

模块与职责见 [`app/README.md`](app/README.md#5-目录)。

---

## 3. 协议（2026-11 实测）

### 3.1 扫码登录

1. `GET https://pc-api.xuexi.cn/open/api/sns/sign` → `{data:{sign}}`（OAuth state）
2. `GET https://login.xuexi.cn/user/qrcode/generate` → `{result:"qr:UUID"}`
3. 渲染 `https://login.xuexi.cn/login/qrcommit?showmenu=false&code=<result>&appId=dingoankubyrfkttorhpou`
4. `POST https://login.xuexi.cn/login/login_with_qr`（form `qrCode / goto=https://oa.xuexi.cn / pdmToken`）→ `11021` 待扫、`11019` 过期、`success` 带 `loginTmpCode`
5. `GET https://pc-api.xuexi.cn/login/secure_check?code=<loginTmpCode>&state=<sign>` → Set-Cookie
6. `GET https://pc-api.xuexi.cn/open/api/user/info` → `{uid, nick}`

### 3.2 积分

`/delegate/score/get`、`/delegate/score/today/query`、`/delegate/score/days/listScoreProgress?sence=score&deviceType=2`

`taskCode`：`1` 阅读文章、`2` 视听学习、`9` 每日登录、`1002` 文章时长、`1003` 视听时长、`6` 每日答题、`5` 每周答题、`4` 专项答题。

### 3.3 内容与答案

- 文章/视频源：`https://www.xuexi.cn/lgdata/<id>.json`
- 答题答案：题目自带「查看提示」，答案在 `<font>` 标签里

> 旧项目（xxqg-helper、TechXueXi）还在用 Selenium 截二维码推钉钉，登录其实不需要浏览器；它们也在用「查看提示」当答案源，说明这条路是对的。

---

## 4. 关键取舍

1. **分数驱动**：每步回查进度，够了就停，不盲刷。
2. **停留要真**：每篇 60 秒起步、逐段下滑、滚到底，短了不计分。
3. **cookie 当密码**：AES-256-GCM 加密落盘，密钥走环境变量；401 立即判失效。
4. **不硬猜题**：提示取不到就跳过，宁可少分不交白卷。
5. **并发靠加 worker**：单上下文 200~300MB，8C16G 单机 4~6 并发封顶；容器 `shm_size` 给 1GB。
6. **限流**：登录 12 次/分/IP；每访客账号数有上限。

---

## 5. 上线要做的

- Nginx 反代 + HTTPS；SSE 路由关 `proxy_buffering`，`proxy_read_timeout` 调大
- `APP_SECRET` 换成真随机；数据卷独立备份
- 上量换 Postgres（`src/db.js` 的 SQL 直接迁），限流换 Redis
- 定时任务错峰：凌晨分批入队，不要整点集中
- 监控：`/healthz` 看 worker 心跳与积压；选择器失配要有告警
- 合规：非官方工具，账号风险自担；商用注意各开源项目 LICENSE

---

## 6. 路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 协议登录、单账号界面、阅读/视听/答题、积分回查 | 已实现，待你真号验证 |
| P1 | 失败重试、选择器健康检查、滑块打磨 | 待做 |
| P2 | 多用户额度、Postgres、调度与掉线提醒 | 待做 |
| P3 | 模拟器补挑战答题/四人赛/双人对战 | 待做 |
| P4 | 本站登录、报表、计费 | 待做 |

---

## 7. 已实测 / 待验证

已实测：签名与二维码接口、二维码解码正确、页面到二维码全链路、多会话并发互不串号、队列任务跑通（含 SSE 结束事件）、越权读取 404。

待验证：真实扫码换 cookie、停留是否稳定涨分、答题页选择器是否仍匹配线上。

先按 [`app/README.md`](app/README.md) 的第 1 节走一遍。
