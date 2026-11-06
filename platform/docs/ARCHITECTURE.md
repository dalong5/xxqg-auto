# xxqg-platform 架构方案

> 一句话：**把「扫码登录 + 每天自动做完学习强国任务」做成一个可交付的 SaaS MVP**。
> 单机可跑（SQLite + 单 worker），每个边界都留了扩容接缝（DB / 队列 / 驱动 / 前端）。

---

## 1. 目标与非目标

### 目标（MVP 必须做到）

| # | 能力 | 验收标准 |
| --- | --- | --- |
| 1 | 访客身份 + 邀请码门禁 | 未持码只能看落地页；持码后可绑定账号 |
| 2 | 账号绑定（扫码） | 二维码 3 分钟有效，扫完自动落库，cookie 加密存储 |
| 3 | 任务编排 | 一次点击跑全套（登录/阅读/视听/答题），或指定子集 |
| 4 | 可观测 | 任务日志实时流（SSE）；`/healthz` `/readyz` `/metrics` |
| 5 | 定时 | 每账号可设 `HH:MM`，到点自动入队，带随机抖动 |
| 6 | 多租户额度 | 每访客最多 N 个账号，超限拒绝 |
| 7 | 断点续跑 | worker 崩溃后任务自动回收重试；cookie 失效标记账号 |

### 非目标（明确不做，避免范围蔓延）

- 不做组织/团队/权限矩阵（MVP 单层租户）。
- 不做移动端 App（响应式 Web 足够）。
- 不做计费/发票（预留 `plan` 字段位即可）。
- 不在本仓库实现「挑战答题/四人赛」等 APP 独有任务（需要另外的协议侧工程）。

---

## 2. 系统全景

```
                    ┌──────────────────────────────┐
  浏览器 (SPA)  ───▶ │  API 进程 (Express)          │
   Cookie: xq_s      │  routes → services → repo    │
    SSE: 日志/扫码    └──────┬───────────────┬───────┘
                            │               │
                    ┌───────▼──────┐  ┌─────▼─────────┐
                    │ SQLite (WAL) │  │ 驱动层 Domain │
                    │ 8 张表        │  │ mock / xxqg   │
                    └───────▲──────┘  └─────▲─────────┘
                            │               │
                    ┌───────┴───────────────┴───────┐
                    │ Worker 进程                    │
                    │ 心跳 / 原子领取 / 超时 / 重试    │
                    └───────────────────────────────┘
                                    │
                                    ▼
                      学习强国站点（Playwright / 原生 Chrome）
```

**为什么 API 与 Worker 分进程**
浏览器自动化是重活（1 个任务几百 MB、几十秒到几十分钟），和 HTTP 抢 CPU/内存会拖垮响应；分开之后 API 可以多副本，Worker 可以按并发水平扩。

**为什么队列先用 DB**
MVP 的吞吐是「每天 1~3 次 × N 个账号」，DB 队列足够，且省掉 Redis 的运维成本。字段语义（status/attempts/worker_id/started_at）与 SQS/Redis Stream 对齐，将来换实现不动业务代码。

---

## 3. 分层与依赖方向

```
http/        只做协议适配：解析、鉴权、序列化、SSE
  ↓ 只能向下
services/    业务规则：额度、幂等、调度、事务边界
  ↓
store/       数据访问：repo（SQL）+ migrations
domain/      外部世界：扫码/分数/任务执行（可替换驱动）
```

铁律：

1. **http 层不写 SQL，store 层不懂 HTTP**。
2. **domain 层不碰数据库**，只接收 cookie 与回调，方便单测与替换。
3. 错误用 `AppError` 带 `code/status`，由 `errorHandler` 统一映射，路由里不出现 `res.status(500)`。

---

## 4. 关键流程

### 4.1 扫码登录（3 段式）

```
POST /accounts/login            → 驱动 createQr() → login_sessions(status=waiting) → {sid, qr}
GET  /accounts/login/:sid       → 驱动 pollQr()   → waiting | scanned | done
GET  /accounts/login/:sid/events→ 服务端替前端轮询，SSE 推状态
done 时：accounts 落库（cookie 用 AES-256-GCM 密封），login_sessions 置 done
```

幂等：同一 `(visitor, platform, uid)` 再次扫码 = 更新 cookie，不新建账号。

### 4.2 任务执行（入队 → 领取 → 事件 → 收尾）

```
POST /accounts/:id/run     → 同账号已有 queued/running 则复用，否则 enqueue
Worker loop:
  beat()                  → workers.seen_at
  requeueDead()           → 回收心跳已停的 worker 的 running 任务
  claim()                 → UPDATE ... RETURNING（原子，避免双 worker 抢单）
  runJob()                → 驱动执行，事件写 job_events
  finish()/retry()        → 成功落 result；失败按 max_attempts 重试
```

**分数是唯一真相**：任务结束必 `fetchScore()` 回写 `accounts.score_*`。
**幂等**：重试不会重复计分——分数来自站点，不来自我们。

### 4.3 定时

API 进程每 15s tick 一次：`schedules.due()` → 入队 → 写回 `next_run_at = 明天同一时刻 + 随机 0~15 分钟`（抖动防整点挤爆）。

---

## 5. 数据模型（详见 `docs/DB.md`）

8 张表：`visitors / accounts / login_sessions / schedules / jobs / job_events / workers / audit_log`。
要点：

- 所有时间戳是毫秒整数，避免时区歧义。
- `accounts.cookie_enc` 是密文，密钥来自 `APP_SECRET` 或 `data/secret.key`（原子创建，绝不覆盖）。
- `jobs` 的 `(status, created_at)` 与 `(account_id, created_at)` 建了索引，队列扫描与账号历史都走索引。
- `job_events.seq` 自增，SSE 用 `seq > after` 做增量游标，天然支持断线重连。

---

## 6. 安全设计

| 面 | 措施 |
| --- | --- |
| 身份 | `xq_s` = `<visitorId>.<HMAC-SHA256>`，HttpOnly + SameSite=Lax，生产加 Secure |
| 越权 | 所有账号/作业操作都校验 `visitor_id` 归属（`getOwned`） |
| 凭据 | 账号 cookie AES-256-GCM 加密落库；密钥不进数据库 |
| 限流 | 登录 10 次/分/访客；写操作 30 次/分；内存桶，扩容换 Redis |
| 邀请码 | `INVITE_CODE` 为空=全开，非空=只放行持码访客 |
| 管理面 | `/api/v1/admin/*` 需 `x-admin-token`；生产应换 SSO/RBAC |
| 输入 | JSON body ≤ 256KB；时间/枚举全部白名单校验 |
| 审计 | 登录、绑定、删除、改定时、审批全部写 `audit_log` |

---

## 7. 可观测性

- **日志**：JSON 单行，含 `rid`（request id）、`visitor`、`jobId`；错误走 stderr。
- **指标**：`/metrics` 暴露作业状态计数、worker 存活数、账号数、今日总分、uptime。
- **健康**：`/healthz`（进程活）、`/readyz`（DB 可用 + 有 worker 心跳）。
- **业务可观测**：`job_events` 就是用户看到的日志，也是排障一手料。

---

## 8. 扩容路径（不改业务代码）

| 现在 | 之后 | 接缝 |
| --- | --- | --- |
| SQLite | Postgres | `store/db.js` 单点替换；repo 里全是标准 SQL |
| DB 队列 | Redis Stream / SQS | `jobs.claim/finish/retry` 三个方法 |
| 单 worker | K8s Deployment + HPA | worker 无状态，靠 `workers` 心跳表协调 |
| 内存限流 | Redis 令牌桶 | `session.rateLimit` |
| 静态前端 | Next.js | `web/` 目录 + `/api/v1` 契约不变 |
| mock 驱动 | 多平台（xxqg/其他） | `domain/index.js` 的 `getDriver()` |

---

## 9. 失败模式与兜底

| 故障 | 表现 | 兜底 |
| --- | --- | --- |
| worker 崩 | 任务卡 running | 心跳 90s 过期 → `requeueDead()` 重新排队 |
| 站点改版 | 任务报错 | 事件留痕 + 账号标记 `expired`；驱动层可独立升级 |
| cookie 过期 | 分数为 0 / 401 | `sync` 任务失败 → 账号标 `expired`，UI 提示重新扫码 |
| 二维码过期 | 3 分钟无操作 | `login_sessions.expires_at`，SSE 推 `expired` |
| 队列堆积 | `readyz` 503 | 指标告警 + 水平扩 worker |
| 密钥丢失 | cookie 解不开 | `tryOpen` 返回 null → 提示重新扫码（不静默失败） |

---

## 10. 部署

```
# 单机
cp .env.example .env && npm ci && npm run migrate
npm run dev          # dev：api+worker 一起
# 生产
node src/index.js &  node src/queue/worker.js &
# 或
docker compose up -d
```

反代（Nginx/Caddy）挂 `:8090`，SSE 需要关缓冲（`proxy_buffering off`）。
