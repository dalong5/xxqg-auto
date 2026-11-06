# 生产故障复盘：同一账号被并发驱动（platform）

> 角色：值班排障。目标不是「改到能跑」，而是找到**为什么偶发**、把不确定性变成确定性。
> 范围：`platform/src/{services,queue,store}`。所有结论都有可复现用例（`test/concurrency.test.mjs`）。

---

## 一、代码功能说明（先建立地图）

| 模块 | 职责 | 关键函数 |
| --- | --- | --- |
| `http/routes/*` | 协议适配：鉴权、序列化、SSE | `POST /accounts/:id/run` |
| `services/accounts.js` | 扫码编排、账号绑定、额度 | `startLogin` / `pollLogin` / `getOwned` |
| `services/jobs.js` | 入队 + 执行 | `enqueueRun` / `runJob` |
| `services/scheduler.js` | 到点入队 | `tickOnce` / `nextRunAt` |
| `queue/worker.js` | 领取、超时、重试、心跳 | `loop` / `exec` / `beat` |
| `store/repos/jobs.js` | 作业 SQL | `claim` / `enqueueRunOnce` / `requeueDead` |

一条 run 作业的完整生命周期：

```
POST /run → enqueueRun → jobs(queued)
worker.loop → claim()（UPDATE…RETURNING）→ exec()
   ├─ runJob → 驱动 runTasks → 事件落 job_events
   ├─ 成功 → jobs.finish(done)
   └─ 失败 → 重试（attempts<max）或 finish(failed)
超时 → Promise.race 抛错 → 同失败分支
```

**并发的三个入口**（这是本次故障的土壤）：
1. 用户点「开始任务」（HTTP）
2. 定时调度 `tickOnce`（API 进程内，15s 一次）
3. 失败重试 / 僵尸任务回收（worker `beat` → `requeueDead`）

---

## 二、故障现象

| 时间 | 现象 | 表面解释（错误） | 真实原因 |
| --- | --- | --- | --- |
| T1 | 用户连点两次「开始任务」，日志出现两条「开始执行」 | 按钮没防抖 | 后端 check-then-act 竞态 |
| T2 | 同账号任务偶发报「不支持多端同时作答」，分数不涨 | 站点风控 | 两个 worker 同时驱动同一账号 |
| T3 | 超时任务被标记 failed，但站点侧仍在继续答题，之后新任务又启动 | 任务没真取消 | `Promise.race` 只拒绝外层，底层工作继续跑 |
| T4 | 双开页面扫码，第二个页面返回 500（`SQLITE_CONSTRAINT`） | 「网络问题」 | `pollLogin` 并发插入同一账号 |

共同特征：**单次跑必成功，压测/手速快/多进程就偶发** —— 典型的 check-then-act 与「取消不等于停止」。

---

## 三、失效原理（分步推演）

### 3.1 重复作业：`activeForAccount` 与 `enqueue` 之间的空窗

```js
// 改造前 services/jobs.js
const active = jobs.activeForAccount(account.id);   // ① 读：没有活跃作业
if (active) return { jobId: active.id, reused: true };
const id = jobs.enqueue({ ... });                   // ② 写：插入一条
```

单进程 Node 里这两步是同步的，看起来安全。但：

- `POST /run` 与 `tickOnce` 可能落在**不同进程**（compose 里 api 与 worker 分容器，API 也可以多副本）；
- 即便同进程，`enqueueRun` 在 scheduler 与 HTTP 里被不同调用栈先后触发，中间只要有一次 `await`（未来加了日志上报就会）就出现交错。

交错后果：

```
t0  A: SELECT … → 无活跃
t1  B: SELECT … → 无活跃
t2  A: INSERT job#1
t3  B: INSERT job#2      ← 两条活跃作业，同一账号
t4  worker1 领 #1, worker2 领 #2 → 两个浏览器同时打同一账号
```

站点侧对同账号双端作答的处置是「中止当前卷子」，于是**两边都拿不到分**，且用户看到的是「偶发失败」。

### 3.2 超时 ≠ 停止：幽灵任务

```js
// 改造前 queue/worker.js
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), T));
const result = await Promise.race([runJob(job), timeout]);   // ← 只是外层不再等
```

`Promise.race` 拒绝的只是**等待**，`runJob` 内部的浏览器仍在跑。于是：

1. 超时 → `jobs.retry(job.id)` 把作业放回队列；
2. 下一个 worker 领到同一条作业 → 又开一个浏览器；
3. 此刻站点上有**两个会话**在答同一张卷子 —— 比重复作业更隐蔽，因为数据库里只有一条作业。

### 3.3 并发扫码 500

`pollLogin` 的顺序是「读会话状态 → `await driver.pollQr()` → 插入账号」。`await` 处让出事件循环，两个并发调用都能看到 `status='waiting'`，于是都去 `INSERT`；`UNIQUE(visitor_id,platform,uid)` 拦下第二条，异常冒到 HTTP 层变成 500。

---

## 四、边界场景（为什么以前没暴露）

| 场景 | 是否触发 | 说明 |
| --- | --- | --- |
| 单用户、慢手速 | 否 | 两次点击间隔远大于 enqueue 的同步窗口 |
| 定时 + 手动同时 | 是 | 07:30 抖动窗口内用户也点了「开始」 |
| 多 API 副本 / 分容器 | 是 | 进程内互斥完全失效 |
| 任务超时（默认 30 分钟） | 是 | 长任务 + 站点卡顿必然发生 |
| 双开标签页扫码 | 是 | SSE 与轮询同时回调 |
| 作业失败重试 | 是 | `retry` 与用户再点「开始」竞争 |
| 进程被 kill -9 | 否（已覆盖） | `requeueDead` 按心跳回收，本次不受影响 |

---

## 五、修复后的生产级代码

原则：**能用数据库约束表达的，就不要用应用层判断**；**能 abort 的，就不要只 race**。

### 5.1 数据库层唯一约束（根治重复作业）

`src/store/migrations/002_active_job_unique.sql`

```sql
-- 先清理历史重复：每账号只保留最新一条活跃 run
UPDATE jobs SET status='cancelled', error=COALESCE(error,'migration 002: duplicate active run'), finished_at=…
WHERE type='run' AND status IN ('queued','running') AND account_id IS NOT NULL
  AND id NOT IN (SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC, id DESC) rn
    FROM jobs WHERE type='run' AND status IN ('queued','running') AND account_id IS NOT NULL
  ) WHERE rn=1);

-- 部分唯一索引：只约束 run 的活跃态，sync/其它类型不受影响
CREATE UNIQUE INDEX uq_jobs_active_run ON jobs (account_id)
WHERE type='run' AND status IN ('queued','running') AND account_id IS NOT NULL;
```

幂等入队（`INSERT OR IGNORE` + 回查，抢不到就复用）：

```js
enqueueRunOnce({ visitorId, accountId, payload, maxAttempts = 2 }) {
  const id = randomId(9);
  const info = d().prepare(
    `INSERT OR IGNORE INTO jobs (id, type, visitor_id, account_id, status, payload, max_attempts, created_at)
     VALUES (?, 'run', ?, ?, 'queued', ?, ?, ?)`).run(id, visitorId, accountId, j(payload), maxAttempts, now());
  if (info.changes > 0) return { id, reused: false };
  const existing = d().prepare(
    "SELECT id FROM jobs WHERE account_id=? AND type='run' AND status IN ('queued','running') LIMIT 1").get(accountId);
  return { id: existing?.id ?? null, reused: true };
}
```

> 为什么不是事务包住「查+插」：SQLite 的 `BEGIN IMMEDIATE` 能解决，但换 Postgres/多进程后仍要靠唯一约束；把不变量写进 schema 才是跨进程可靠的。

### 5.2 真取消 + 账号锁（根治幽灵任务）

```js
// queue/worker.js
const busy = new Set();                       // 进程内账号锁

const ac = new AbortController();
const timeout = new Promise((_, rej) => {
  timer = setTimeout(() => { ac.abort(); rej(new Error('任务超时')); }, config.jobTimeoutMs);
});
const work = runJob(job, { onEvent: emit, signal: ac.signal });
// 不论超时与否，都等真正的工作收尾再释放账号
const release = work.catch(() => {}).finally(() => { busy.delete(accountKey); running -= 1; clearTimeout(timer); });

try { const r = await Promise.race([work, timeout]); jobs.finish(job.id, { status: 'done', result: r }); }
catch (err) { /* aborted 不重试，直接 failed；其余按 attempts 重试 */ }
finally { if (!settled) await Promise.race([release, sleep(10_000)]); }   // 宽限期
```

领取前二次校验，防止「上一单还没收尾」：

```js
if (busy.has(accountKey)) { jobs.retry(job.id); await sleep(500); continue; }
busy.add(accountKey);
```

驱动侧真正响应 abort：

```js
// mock-driver.js：sleep 支持 signal，任务循环入口检查
const sleep = (ms, signal) => new Promise((resolve, reject) => { … signal?.addEventListener('abort', onAbort, {once:true}) });

// xqgq-driver.js：浏览器任务无法中途杀，但保证「取消后不再开下一项」
for (const kind of kinds) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
  …
}
```

### 5.3 幂等绑定（根治并发扫码 500）

```js
// store/repos/accounts.js
ensure({ visitorId, uid, nick, cookieEnc, platform }) {
  d().prepare(`INSERT OR IGNORE INTO accounts (…) VALUES (…)`).run(…);
  const row = this.byUid(visitorId, uid, platform);
  if (row && row.cookie_enc !== cookieEnc) {
    d().prepare('UPDATE accounts SET cookie_enc=?, status=?, last_sync_at=? WHERE id=?').run(…);
    return this.get(row.id);
  }
  return row;
}
```

`pollLogin` 改为：先按需校验额度 → `ensure()` → 更新会话。双开页面/SSE 与轮询同时回调都只会得到同一个账号。

---

## 六、验证

```
$ npm test
✔ 同一账号并发入队 5 次 → 只产生 1 条作业（DB 唯一索引兜底）
✔ sync 作业不受 run 的唯一约束影响（可并存）
✔ 作业结束后可以再次入队（索引只约束活跃态）
✔ 并发扫码回调只绑一个账号，不抛 500
✔ abort 后驱动立即停止，不会把剩余任务跑完
✔ 扫码 → 绑定账号 → 跑任务 → 分数上涨
… ℹ tests 18  ℹ pass 18  ℹ fail 0
```

回归验证（真浏览器）：`node scripts/uitest.mjs` → `log lines: 11 / score now: 43 / page errors: none`。

修复前后对比：

| 维度 | 修复前 | 修复后 |
| --- | --- | --- |
| 重复作业 | 应用层 check-then-act，多进程必现 | DB 部分唯一索引，跨进程成立 |
| 超时处理 | 只停止等待，底层继续跑 | `AbortController` 真取消 + 10s 宽限期 |
| 账号并发 | 无进程内互斥 | `busy` 账号锁 + 领取前复查 |
| 并发扫码 | 第二个请求 500 | `INSERT OR IGNORE` 幂等，返回同一账号 |
| 历史脏数据 | 迁移会失败 | 迁移先按 `ROW_NUMBER()` 清理再建索引 |

---

## 七、遗留与下一步

以下三项在复盘后已一并修复（migration 003）：

### 7.1 分数快照单调守卫（`accounts.score_seq`）

`sync` 与 `run` 都会写 `accounts.score_*`。若一次慢请求返回旧分数，会把刚拿到的分覆盖回去（`app/` 工程里已踩过同样的坑）。现在写入带序号，只接受更新的快照：

```js
saveScore(id, { day, total, today, tasks }, seq = now()) {
  return d().prepare(
    `UPDATE accounts SET day=?, score_total=?, score_today=?, score_json=?, last_sync_at=?, score_seq=?
     WHERE id=? AND score_seq <= ?`).run(…, seq, id, seq).changes;
}
```

同序号并发写用 `<=`：后到者胜，不会两边都失败。返回 `changes` 便于调用方判断是否被丢弃。

### 7.2 跨进程账号租约（`accounts.locked_by/locked_until`）

`busy` 只是进程内 Set，多 worker 时无效。现在领取作业后先抢租约，抢不到就放回队列：

```js
acquireLease(id, owner, ttlMs) {
  return d().prepare(
    'UPDATE accounts SET locked_by=?, locked_until=? WHERE id=? AND (locked_until IS NULL OR locked_until < ?)'
  ).run(owner, now() + ttlMs, id, now()).changes > 0;
}
```

- worker 领取成功后 `acquireLease(acct, WORKER_ID, jobTimeout + 60s)`；失败 → `jobs.retry` + 事件 `job_leased`；
- `exec` 的 finally 里 `releaseLease`（成功/失败/超时都释放）；
- `beat()` 每 20s `expireLeases()` 清理僵尸租约（worker 被 kill -9 时靠这个接管）。

### 7.3 回收事件可观测

`requeueDead()` 改成 `RETURNING id, account_id, worker_id`，worker 收到后为每个作业写 `job_requeued` 事件，日志里能直接看到「谁失联、哪条作业被回收」。

### 7.4 仍未做（明确交接）

- `job_events` 的定期清理接口有了但没挂定时（建议在 `beat` 里每天跑一次 `trim(7)`）。
- `app/` 第一代工程仍在运行（8099），合并/下线需走影子对比，见 `REFACTOR.md` 的 S4。
