# 代码库研读与重构报告

对象：`xxqg/`（`app/` 第一代工程 + `platform/` 第二代产品 + `research/` 证据库）
原则：**业务行为不变**，只做结构化拆分、去重、去 N+1、去死代码；每一步都有测试兜底。

---

## 一、架构概要

### 1.1 仓库里其实有「两代系统」

```
xxqg/
├── app/           ① 第一代：单机自用 + 浏览器自动化研究（仍在跑，端口 8099）
│   └── src/{server,worker,db,loginflow,auth,crypto}.js + xxqg/{client,browser,tasks,plain}.js
├── platform/      ② 第二代：产品化 MVP（端口 8090，本报告的改造对象）
│   └── src/{http,services,store,queue,domain}
├── research/      ③ 证据库：第三方逆向工程、题库、抓包产物（只读）
└── docs/          ④ 协议/进度/交接/故障复盘
```

两代系统**数据面互不相通**：`app/` 用 `app/data/app.db`，`platform/` 用 `platform/data/platform.db`；两者都实现了「访客 / 账号 / 队列 / 事件 / worker 心跳」，属于**同构实现**。

### 1.2 第二代（platform）的数据流

```
浏览器 SPA
  │ ① GET /me（签名 cookie 认身份）
  │ ② POST /accounts/login → 驱动 createQr() → login_sessions(waiting)
  │ ③ GET  /accounts/login/:sid/events（SSE，服务端替前端轮询驱动）
  │ ④ POST /accounts/:id/run → jobs(queued) → 事件 queued
  ▼
Worker 进程
  │ ⑤ beat() 写 workers.seen_at；requeueDead() 回收僵死
  │ ⑥ claim() 原子领取（UPDATE ... RETURNING）
  │ ⑦ runJob() → 驱动 runTasks() → onEvent 落 job_events
  │ ⑧ finish()/retry()；分数回写 accounts.score_*
  ▼
SSE 把 job_events 增量推给前端（seq 游标，断线可续）
```

调度线程（API 进程内，每 15s）：`schedules.due()` → 入队 → `next_run_at = 明天 + 0~15min 抖动`，顺带过期扫码会话。

---

## 二、问题清单

按「影响面 × 修复成本」排序。P0 = 会直接导致线上故障或改不动代码；P3 = 洁癖级。

| # | 级别 | 问题 | 证据 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | **P0** | 两套系统同构并存，队列/账号/事件各写一遍 | `app/src/db.js`(224 行) 与 `platform/src/store/repo.js` 都有 `claimJob/finishJob/beat/requeueDeadJobs` | 改一个 bug 要改两处；新人不知道以哪个为准；线上跑着两套端口 |
| 2 | **P1** | `repo.js` 是 400 行上帝模块，8 个聚合挤在一起 | 改造前单文件 8 个 `export const`，跨 262 行 | 任何表结构变动都要在同一个文件里大海捞针；merge 冲突高发 |
| 3 | **P1** | `services/jobs.js` 一个文件三种职责：入队 / 执行 / 调度 | 改造前同文件含 `enqueueRun/runJob/startScheduler` | 调度逻辑无法单测（副作用在 setInterval 里），也无法在只跑 API 的进程里关掉 |
| 4 | **P1** | `/metrics` 每次抓取把 1000 条 job 拉到 Node 里 filter | 改造前 `jobs.recent({limit:1000}).filter(...)` ×4 | Prometheus 15s 一次 → 每分钟 4000 行 JSON 解析；账号多了直接打满 CPU |
| 5 | **P1** | `/me` 的账号列表 N+1 查询 | 改造前 `listByVisitor()` 后逐个 `schedules.byAccount()` | 10 个账号 = 11 次 SQL；N 个账号线性放大 |
| 6 | **P2** | `masterKey()` 每次 seal/open 都读文件/算哈希 | 改造前 `crypto.js` 在 `seal/open` 里直接调 | 每次扫码、每个任务都多一次磁盘 IO + SHA-256 |
| 7 | **P2** | 访问日志把静态资源也记了 | 改造前 `accessLog` 无差别记录 | 一次页面加载 3 条噪音，业务日志被冲掉，检索成本变高 |
| 8 | **P2** | 任务清单在 3 处各写一份 | `domain/index.js` 的 `TASK_KINDS`、`jobs.js` 的 `normalizeTasks`、UI 的 `TASK_LABEL/CODE_OF` | 加一个新任务类型要改 3 个文件，漏一处就静默不生效 |
| 9 | **P2** | `logins.expireStale()` 写了但没人调用 | 改造前只在 repo 里定义 | 扫码会话表无限增长，`waiting` 记录永不过期 |
| 10 | **P2** | 前端每 20s 全量 `innerHTML` 重建账号卡 | 改造前 `render()` 里 `root.innerHTML=''` | 轮询会把按钮 disabled 状态、滚动位置、正在看的日志面板全部重置 |
| 11 | **P3** | 重复 import / 未用变量 | `routes/auth.js` 两行 import 同一个 `store/repo.js` | 无功能影响，但会误导读者以为有两条路径 |
| 12 | **P3** | `updateLogin` 用列名拼接 SQL | 改造前 `Object.keys(fields)` 直接进 SQL | 当前调用方受控，属于隐患而非漏洞；已加白名单 |

---

## 三、重构方案

### 3.1 总体策略

1. **不动第二代的对外契约**（URL、字段、SSE 事件名全部保持），只改内部结构 → 前端与测试零改动即可验证。
2. **先加测试再改结构**：`test/*.test.mjs` 覆盖「扫码→绑定→跑任务→分数」「额度」「404」「定时校验」，重构后必须全绿。
3. **每次只做一类改动**：拆模块 / 去 N+1 / 去死代码分开提交，出问题能精确回滚。
4. **第一代 `app/` 冻结**：只作为研究harness 与浏览器自动化实现来源，不再加功能；产品能力全部进 `platform/`（长期：把 `platform/domain/xxqg-driver.js` 依赖的 4 个文件迁进来，`app/` 归入 `research/`）。

### 3.2 分阶段计划

| 阶段 | 内容 | 风险 | 验证 |
| --- | --- | --- | --- |
| S1（本次） | 拆 `repo.js`、拆 `scheduler.js`、去 N+1、指标走聚合、密钥缓存、日志降噪、任务清单归一、死代码接上、前端定点更新 | 低（纯内部） | 13 个测试 + 浏览器冒烟 |
| S2 | 把 `services/*` 的副作用（发送事件、时间）显式注入，便于纯函数测试 | 中 | 新增单测 |
| S3 | 队列抽象成接口（`queue/backend-db.js`），为 Redis/SQS 留位 | 中 | 双后端跑同一套集成测试 |
| S4 | 第一代 `app/` 迁移收尾：domain 四个文件入库到 `platform/src/domain/legacy/`，删除 `app/src/server|worker|db` | 高（涉及线上 8099） | 影子流量对比 |

---

## 四、本次落地的重构（含前后对比）

### 4.1 拆上帝模块：`store/repo.js` → `store/repos/*`

改造前：一个文件 8 个聚合对象、262 行，所有 SQL 混排。
改造后：按聚合拆 8 个文件 + 一个 barrel，**调用方 import 路径不变**。

```
store/
├── repo.js              # barrel：只做 re-export（10 行）
├── repos/
│   ├── _util.js         # d() / parse / j / now
│   ├── visitors.js      # 40 行（含 LEFT JOIN 聚合与 countAccounts 口径统一）
│   ├── accounts.js      # 70 行（含 listWithSchedule）
│   ├── logins.js        # 40 行（update 加列名白名单）
│   ├── schedules.js     # 35 行
│   ├── jobs.js          # 80 行（含 countByStatus）
│   ├── events.js        # 25 行
│   ├── workers.js       # 20 行（beat 改 UPSERT）
│   └── audit.js         # 12 行
```

### 4.2 去 N+1：`listForVisitor`

```js
// 改造前：1 + N 次查询
const list = accounts.listByVisitor(visitor.id).map(accounts.publicView);
for (const a of list) {
  const s = schedules.byAccount(a.id);      // ← N 次
  a.schedule = s ? { at: s.at, nextRunAt: s.next_run_at } : null;
}
```

```js
// 改造后：1 次 LEFT JOIN
listWithSchedule(visitorId) {
  const rows = d().prepare(
    `SELECT a.*, s.at AS schedule_at, s.next_run_at AS schedule_next
     FROM accounts a LEFT JOIN schedules s ON s.account_id = a.id
     WHERE a.visitor_id = ? AND a.status != 'disabled'
     ORDER BY a.created_at ASC`).all(visitorId);
  return rows.map((r) => ({ ...this.publicView(r), schedule: r.schedule_at ? { at: r.schedule_at, nextRunAt: r.schedule_next } : null }));
}
```

### 4.3 指标与探针走 SQL 聚合

```js
// 改造前：把 1000 行拉进内存再 filter（每个指标一次）
const all = jobs.recent({ limit: 1000 });
const by = (s) => all.filter((j) => j.status === s).length;
```

```js
// 改造后：一条 GROUP BY
countByStatus() {
  const out = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of d().prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) out[r.status] = r.n;
  return out;
}
// /readyz 也不再拉 500 行算 queued，直接 countByStatus().queued
```

### 4.4 调度从作业服务里拆出来

```js
// 改造前 services/jobs.js：入队 + 执行 + setInterval 调度三合一
export function startScheduler() { ... setInterval(tick) ... }
```

```js
// 改造后 services/scheduler.js：纯函数 tickOnce() + 薄包装 startScheduler()
export function nextRunAt(at, from = Date.now()) { /* HH:MM + 0~15min 抖动 */ }
export function tickOnce(now = Date.now()) { /* due → 入队 → markRun → 顺带 expireStale */ }
export function startScheduler(intervalMs = 15_000) { /* setInterval(tickOnce) */ }
```

好处：`tickOnce()` 可直接单测（本次新增用例），也只依赖 repo，不依赖 worker。

### 4.5 任务清单归一化

```js
// 新增 domain/tasks.js：TASK_KINDS / TASK_LABEL / normalizeTasks（去重+过滤未知+空回退全套）
// domain/index.js 只负责选驱动，并 re-export 这三个；jobs.js 不再自己写一份过滤逻辑
```

### 4.6 其他小改

| 位置 | 改动 |
| --- | --- |
| `crypto.js` | 模块级缓存主密钥，`seal/open` 不再重复读文件 |
| `http/middleware.js` | `accessLog` 只记 `/api/*`、`/`、`*.html` |
| `store/repos/workers.js` | `beat()` 改 `INSERT ... ON CONFLICT DO UPDATE`，少一次往返 |
| `store/repos/logins.js` | `update()` 列名白名单；`expireStale()` 接进调度 tick |
| `routes/auth.js` | 去掉重复 import，`/me` 复用 `listForVisitor`（顺带获得 schedule 字段） |
| `web/app.js` | 增加 `state.renderSig` + `patchCard()`：账号集合未变时只更新分数/定时/chips，不重建 DOM |

---

## 五、验证

```
$ npm test                       # 改造后新增 7 个单元用例
✔ healthz 可用
✔ 匿名 /me 返回 driver 与额度
✔ 扫码 → 绑定账号 → 跑任务 → 分数上涨
✔ 额度用满后再扫码返回 400
✔ 不存在的作业返回 404 且带 requestId
✔ 定时接口校验时间格式
✔ visitors.list 用 LEFT JOIN 带出账号数（替代 N+1）
✔ accounts.listWithSchedule 一条 SQL 带出定时
✔ listWithSchedule 不泄露 cookie_enc
✔ jobs.countByStatus 走 SQL 聚合
✔ normalizeTasks：去重、过滤未知项、空值回退全套
✔ nextRunAt 落在 HH:MM 之后 0~15 分钟
✔ tickOnce 到点入队并推进 next_run_at
ℹ tests 13  ℹ pass 13  ℹ fail 0

$ node scripts/uitest.mjs        # 真浏览器点一遍（行为不变）
driver: mock · modal: true · account: 演示账号2
log lines: 12 · score now: 43 · page errors: none
```

性能前后（同一台机器，mock 驱动）：

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| `/me`（10 个账号） | 11 次 SQL | 2 次 SQL |
| `/metrics` | 拉 1000 行 + 4 次 filter | 1 条 GROUP BY + 1 条 count |
| `/readyz` | 拉 500 行 | 1 条 GROUP BY |
| `seal/open` | 每次读 key 文件 | 进程内缓存 |
| 前端轮询 | 全量重建 DOM | 未变更时仅 patch 文本 |

---

## 六、遗留风险与建议

1. **两套系统并存（P0）**：本次没有合并，因为 `app/` 正跑着真实任务，贸然迁移风险高。建议按 S4 做影子对比后下线 `app/src/{server,worker,db}.js`。
2. **`job_events` 无上限增长**：已有 `trim(7)` 与管理接口，但没人定时调用；建议在调度 tick 里做「每天一次」的低频清理。
3. **SSE 每连接一个轮询循环**：连接数上去后 `job_events` 查询会变成热点；扩容时改成「进程内事件总线 + 单次 DB 查询」。
4. **`app/src/xxqg/plain.js` 402 行仍是上帝模块**（协议探针 + 坐标换算 + 答题策略混在一起），S4 迁移时按「页面探针 / 坐标换算 / 答题策略」三拆。
