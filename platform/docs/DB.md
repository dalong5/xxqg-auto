# 数据库表结构

SQLite（WAL）。迁移文件在 `src/store/migrations/`，按文件名顺序执行，记录在 `_migrations`。
所有时间戳 = 毫秒整数；所有主键 = TEXT（base64url 随机串）。

---

## 实体关系

```
visitors 1──n accounts 1──n jobs
    │             │            └──n job_events
    │             └──1 schedules
    └──n login_sessions

workers   独立心跳表（无外键，进程注销即陈留）
audit_log 独立审计表（无外键，比业务数据活得久）
```

---

## visitors（终端用户 / 租户）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 访客 id（写进签名 cookie） |
| `code` | TEXT UNIQUE | 邀请码（可空；同一码可分发给多人） |
| `approved` | INT | 0=待放行，1=可用 |
| `max_accounts` | INT | 额度，默认 1 |
| `note` | TEXT | 运营备注 |
| `created_at` / `seen_at` | INT | 创建 / 最近活跃 |

## accounts（平台账号）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `visitor_id` | TEXT FK→visitors | 归属，级联删除 |
| `platform` | TEXT | `xxqg`（预留多平台） |
| `uid` | TEXT | 平台侧用户 id |
| `nick` | TEXT | 昵称快照 |
| `cookie_enc` | TEXT | **AES-256-GCM 密文**（不是明文！） |
| `status` | TEXT | `active` / `expired` / `disabled` |
| `day` | TEXT | 最近一次分数所属日期 `YYYY-MM-DD` |
| `score_total` / `score_today` | INT | 总分 / 今日分 |
| `score_json` | TEXT | 分任务明细（name/done/max） |
| `last_sync_at` | INT | |
| `created_at` | INT | |

唯一约束 `(visitor_id, platform, uid)`：重复扫码只更新 cookie。
索引：`idx_accounts_visitor`。

## login_sessions（扫码会话）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `sid` | TEXT PK | |
| `visitor_id` | TEXT FK | |
| `platform` | TEXT | |
| `status` | TEXT | `waiting`/`scanned`/`done`/`failed`/`expired` |
| `qr` | TEXT | 驱动侧的二维码引用（不是图片） |
| `account_id` | TEXT | 成功后回填 |
| `error` | TEXT | |
| `created_at` / `updated_at` / `expires_at` | INT | 默认 3 分钟 |

索引：`idx_login_status(status, expires_at)`，用于批量过期。

## schedules（定时）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `account_id` | TEXT FK UNIQUE | 一个账号一条 |
| `visitor_id` | TEXT | 冗余，便于按租户统计 |
| `at` | TEXT | `"HH:MM"` |
| `enabled` | INT | |
| `next_run_at` | INT | 下次触发时间（含抖动） |
| `created_at` | INT | |

## jobs（作业队列）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | |
| `type` | TEXT | `run` / `sync` / `login` / `selftest` |
| `visitor_id` / `account_id` | TEXT | 归属 |
| `status` | TEXT | `queued`/`running`/`done`/`failed`/`cancelled` |
| `payload` | TEXT | JSON（如 `{tasks:[...]}`） |
| `result` | TEXT | JSON |
| `error` | TEXT | 截断 2000 字 |
| `attempts` / `max_attempts` | INT | 重试控制 |
| `worker_id` | TEXT | 领取者 |
| `created_at` / `started_at` / `finished_at` | INT | |

索引：`idx_jobs_status(status, created_at)`（队列扫描）、`idx_jobs_account(account_id, created_at DESC)`（账号历史）。

**原子领取**（多 worker 安全）：

```sql
UPDATE jobs SET status='running', worker_id=?, started_at=?, attempts=attempts+1
WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1)
  AND status='queued'
RETURNING *;
```

## job_events（事件流 / 用户可见日志）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `seq` | INTEGER PK AUTOINCREMENT | SSE 游标 |
| `job_id` / `account_id` | TEXT | 二选一或都有 |
| `level` | TEXT | `debug`/`info`/`warn`/`error` |
| `type` | TEXT | `queued`/`start`/`task_start`/`task_done`/`finished`/`job_failed`… |
| `message` | TEXT | 给人看的一句话 |
| `payload` | TEXT | 结构化附加（如整份分数） |
| `created_at` | INT | |

索引：`idx_events_job(job_id, seq)`、`idx_events_time(created_at)`。

## workers（心跳）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `w-<pid>` |
| `host` / `pid` / `concurrency` | | 诊断用 |
| `started_at` / `seen_at` | INT | `seen_at` 超过 90s 视为死亡 |

## audit_log（审计）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `actor` | TEXT | 访客 id / `admin` / 系统 |
| `action` | TEXT | `login.start`/`login.done`/`account.remove`/`schedule.set`/`visitor.approve`… |
| `target` | TEXT | 目标 id |
| `meta` | TEXT | JSON |
| `created_at` | INT | |

---

## 运维要点

- **WAL**：读写不互斥；备份要连同 `-wal`/`-shm` 一起，或用 `VACUUM INTO`。
- **清理**：`POST /admin/maintenance/trim` 删 7 天前事件与陈旧 worker；`job_events` 是增长最快的表。
- **迁移**：新增 `002_xxx.sql` 即可，启动时自动执行；失败整体回滚。
- **密钥轮换**：`APP_SECRET` 一改，所有 `cookie_enc` 解不开 → 账号变 `expired`，需要重新扫码。这是有意的安全取舍。
