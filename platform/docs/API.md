# API 端点定义（v1）

Base：`/api/v1`（探针在根路径）。所有请求/响应均为 JSON，除非标注 SSE。
身份通过 `xq_s` Cookie 传递（首次访问自动下发）。错误统一为：

```json
{ "error": { "code": "bad_request", "message": "…", "details": {}, "requestId": "ab12cd34" } }
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `bad_request` | 参数不合法 |
| 401 | `unauthorized` | 未登录 |
| 403 | `forbidden` | 需要邀请码 / 非本人资源 / 需要管理员令牌 |
| 404 | `not_found` | 资源不存在 |
| 409 | `conflict` | 额度已满等冲突 |
| 429 | `rate_limited` | 频率超限 |
| 502 | `upstream_error` | 上游（学习强国/驱动）异常 |

---

## 身份

### `GET /me`
返回身份、额度、账号列表与当前驱动。

```json
{
  "visitor": { "id": "rTVmNhAw5Ydc", "approved": true, "maxAccounts": 1 },
  "needInvite": false,
  "driver": "mock",
  "accounts": [
    { "id": "acc1", "uid": "mock-1001", "nick": "演示账号1", "status": "active",
      "scoreToday": 12, "scoreTotal": 212, "tasks": { "1": { "name": "阅读文章", "done": 12, "max": 12 } },
      "lastSyncAt": 1760000000000, "schedule": { "at": "07:30", "nextRunAt": 1760020000000 } }
  ],
  "quota": { "used": 1, "max": 1 }
}
```

### `POST /register`
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `invite` | string | 邀请码；服务端未配置 `INVITE_CODE` 时忽略 |

`200 {ok:true, approved:true, maxAccounts:1}` · `403 邀请码不对`

### `POST /logout`
清 Cookie。`200 {ok:true}`

---

## 账号与扫码

### `POST /accounts/login`
生成登录会话（二维码）。限流 10 次/分钟/访客。

```json
{ "sid": "OnlJcfWZaiaJHdrR", "qr": "mock://login/xxxx", "ttlMs": 180000 }
```

`400 最多绑定 N 个账号`（额度用满）

### `GET /accounts/login/:sid`
轮询状态。`{ "status": "waiting" | "scanned" | "done" | "expired", "accountId"?: "acc1" }`

### `GET /accounts/login/:sid/events`（SSE）
服务端替前端轮询，事件：

```
event: status
data: {"status":"scanned"}
event: status
data: {"status":"done","accountId":"acc1"}
```

### `GET /accounts`
`{ "accounts": [ …同 /me.accounts ] }`

### `DELETE /accounts/:id`
删除账号及其定时（级联）。`{ "ok": true }`

### `POST /accounts/:id/run`
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tasks` | string[] | 可选，默认全套 `login,article,video,daily,weekly,special` |

`{ "jobId": "job1", "reused": false }` —— 同账号已有进行中任务时 `reused=true` 并返回其 jobId。

### `POST /accounts/:id/sync`
只同步分数（轻量）。`{ "jobId": "job2" }`

### `PUT /accounts/:id/schedule`
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `at` | `"HH:MM"` | 空字符串或 `enabled:false` = 取消定时 |
| `enabled` | boolean | 默认 true |

`{ "ok": true, "schedule": { "at": "07:30", "nextRunAt": 1760020000000 } }` · `400 时间格式应为 HH:MM`

### `GET /accounts/:id/events?limit=80`
账号最近的作业事件（首屏历史，之后接 SSE）。

```json
{ "events": [ { "seq": 12, "level": "info", "type": "task_done", "message": "阅读文章 完成", "payload": null, "created_at": 1760000000000 } ] }
```

---

## 作业

### `GET /jobs/:id`
`{ "job": { "id, type, status, payload, result, error, attempts, createdAt, startedAt, finishedAt" }, "events": [...] }`

### `GET /jobs/:id/events?after=<seq>`（SSE）

```
event: log
data: {"seq":13,"level":"info","type":"task_start","message":"开始 视听学习","created_at":…}

event: done
data: {"status":"done","result":{…},"error":null}
```

`after` 用于断线重连补历史；作业终态后服务端主动关闭。

### `GET /jobs?account=<id>&limit=20`
最近作业列表。

---

## 管理面（需 `x-admin-token`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/overview` | 驱动、环境、访客/账号/worker/作业计数 |
| GET | `/admin/visitors` | 访客列表（含账号数） |
| POST | `/admin/visitors/:id/approve` | `{approved:true}` 放行/封禁 |
| POST | `/admin/visitors/:id/quota` | `{maxAccounts:1..20}` 调额度 |
| GET | `/admin/audit` | 最近 200 条审计 |
| POST | `/admin/maintenance/trim` | 清理 7 天前事件 + 陈旧 worker |

---

## 探针（根路径，无需身份）

| 路径 | 语义 |
| --- | --- |
| `GET /healthz` | 进程存活 `{ok, uptime}` |
| `GET /readyz` | DB 可用且至少 1 个 worker 心跳，否则 503 |
| `GET /metrics` | Prometheus 文本（作业计数/worker/账号/今日总分/uptime） |

---

## SSE 约定

- `content-type: text/event-stream`，`cache-control: no-cache`。
- 15s 一次 `: ping` 注释帧保活。
- 断线重连：客户端带 `?after=<最后 seq>` 即可补齐，不会重复也不会丢。
- 反代必须关闭缓冲（Nginx `proxy_buffering off;`）。
