# xxqg-platform

学习强国自动化任务的 **SaaS MVP**：扫码一次，之后每天自动把分做完。
Node 24 + Express + SQLite(WAL) + 队列 worker，前端零构建，Docker 一键起。

> 架构 / API / 表结构 / UI 分别在 [`docs/`](docs)：[ARCHITECTURE](docs/ARCHITECTURE.md) · [API](docs/API.md) · [DB](docs/DB.md) · [UI](docs/UI.md)。

---

## 5 分钟跑起来

```bash
cd platform
cp .env.example .env          # 生产记得改 APP_SECRET
npm ci
npm run dev                   # API :8090 + worker
```

打开 http://127.0.0.1:8090 —— 默认 `DOMAIN_DRIVER=mock`，**不需要真实账号**就能点完整流程：
点「+」→ 二维码 → 2.5 秒后自动「扫码成功」→ 账号卡出现 → 「开始任务」→ 日志逐行滚出 → 分数上涨。

```
npm test                       # 6 个集成用例：注册/扫码/跑任务/额度/404/定时校验
curl localhost:8090/readyz      # {"ready":true,"workers":1,...}
curl localhost:8090/metrics     # Prometheus 文本
```

### 切到真实站点

```bash
# .env
DOMAIN_DRIVER=xxqg
LEGACY_DOMAIN_DIR=../app/src/xxqg      # 复用已跑通的协议+浏览器实现
XXQG_HEADED=1                          # 本机调试用有头浏览器
```

`xxqg` 驱动会调用 `../app/src/xxqg/{client,tasks}.js`：登录/分数走 HTTP，阅读/视听/答题走真实浏览器。
每日答题必须走「原生 Chrome + OS 输入」通道，原因见 [../docs/POSTMORTEM.md](../docs/POSTMORTEM.md)。

---

## 目录结构

```
platform/
├── src/
│   ├── index.js               # 组合根：配置 → DB → HTTP → 调度 → 优雅退出
│   ├── config.js              # 环境变量 + 启动自检 + 主密钥
│   ├── logger.js              # JSON 结构化日志（带 rid / jobId 上下文）
│   ├── errors.js              # AppError + 语义化构造器
│   ├── crypto.js              # AES-256-GCM 密封 / HMAC 签名 cookie
│   ├── http/
│   │   ├── app.js             # Express 装配
│   │   ├── middleware.js      # requestId / 访问日志 / 404 / 错误映射
│   │   ├── sse.js             # SSE 工具（心跳、增量）
│   │   └── routes/{auth,accounts,jobs,admin,health}.js
│   ├── services/
│   │   ├── session.js         # 访客 cookie、邀请码门禁、限流
│   │   ├── accounts.js        # 扫码编排、账号 CRUD、定时设置
│   │   └── jobs.js            # 入队、执行、调度 tick
│   ├── store/
│   │   ├── db.js              # 连接 + 迁移执行器 + 事务
│   │   ├── repo.js            # 8 张表的仓储（唯一写 SQL 的地方）
│   │   └── migrations/001_init.sql
│   ├── queue/worker.js        # 心跳 / 原子领取 / 超时 / 重试 / 优雅停机
│   └── domain/
│       ├── index.js           # 驱动接口与注册
│       ├── mock-driver.js     # 演示与测试（默认）
│       └── xxqg-driver.js     # 真实站点适配
├── web/                       # 零构建前端（index.html / styles.css / app.js）
├── test/api.test.mjs          # 集成测试
├── scripts/dev.mjs            # api+worker 一起跑
├── Dockerfile / docker-compose.yml
└── docs/{ARCHITECTURE,API,DB,UI}.md
```

---

## 核心设计取舍

| 决策 | 原因 | 代价 |
| --- | --- | --- |
| SQLite + WAL | MVP 单机，零运维；吞吐足够 | 写并发有限；换 Postgres 只动 `store/db.js` |
| DB 当队列 | 省 Redis；字段语义对齐 SQS | 高频轮询有 DB 压力（当前 700ms 一次） |
| API/Worker 分进程 | 浏览器重活不拖垮 HTTP | 多一个部署单元 |
| 驱动层可替换 | 演示/测试不依赖真实账号 | 需要维护两套驱动 |
| 零构建前端 | 秒开、可直接 CDN | 复杂交互要自己写 |
| 分数只信站点 | 不伪造、不本地累加 | 任务结束必须多打一次接口 |

---

## 生产清单

- [ ] `APP_SECRET` 换成 32+ 随机串（换了要重新扫码）
- [ ] `NODE_ENV=production`（Cookie 加 Secure）
- [ ] 反代关掉 SSE 缓冲：`proxy_buffering off;`
- [ ] 前面挂 HTTPS（Caddy/Nginx）
- [ ] `docker compose up -d` 且 `restart: unless-stopped`
- [ ] 定时清理：`POST /api/v1/admin/maintenance/trim`（或 cron）
- [ ] 监控 `/readyz` 与 `xxqg_jobs_total{status="queued"}` 堆积

## Docker

```bash
docker compose up -d --build
```

`Dockerfile` 基于 `node:24-slim`，两阶段（deps → runtime），非 root 运行，含 `HEALTHCHECK`。
