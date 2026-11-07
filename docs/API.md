# HTTP API 契约

2026-11-07，按 `app/src/app.js` 实现整理；每周自动计划已按要求移除。浏览器同源调用；生产入口使用 HTTPS。请求和响应通常为 JSON，事件端点为 SSE。

## 会话与权限

访问 API 自动签发 `xxqg_v` Cookie：HttpOnly、SameSite=Lax、HMAC 签名、180 天有效期。生产 Nginx 为它附加 Secure。Cookie 即本浏览器工作区的访问凭证，不能公开分享；清除 Cookie 后需要重新扫码。

无需网站用户名/密码。学习账号仅在 APP 扫码确认后绑定。所有账号、任务、验证请求均在服务端检查当前归属；请求中传入 `visitor_id` 不会赋予权限。账号重新扫码转移归属后，旧访客的任务事件访问会被拒绝。

## 端点

| 方法 / 路径 | 请求 | 成功响应 | 主要失败 |
| --- | --- | --- | --- |
| `GET /api/me` | 无 | `{visitor, accounts, maxAccounts, taskNames}` | — |
| `GET /healthz` | 无 | `{ok:true, queued, workers, at}` | 进程/数据库异常时不能作为就绪证明 |
| `GET /api/users` | 无 | 当前访客的账号数组 | — |
| `DELETE /api/users/:uid` | 无 | `{ok:true}` | 404 非本人账号；409 有排队/运行任务 |
| `POST /api/login/start` | 无 | `{sid}` | 429 同 IP 每分钟超过 12 次 |
| `GET /api/login/:sid` | 无 | `{status,error,uid,qr?}` | 404 会话不存在或无权限 |
| `GET /api/login/:sid/events` | 无 | SSE，二维码/成功/失败事件 | 404 无权限，无 JSON 正文 |
| `POST /api/users/:uid/sync` | 无 | `{jobId}` 或 `{jobId,reused:true}` | 404 无权限 |
| `POST /api/users/:uid/run` | `{tasks?: string[]}` | `{jobId,tasks,queued,reused?}` | 400 未知任务；404 无权限 |
| `GET /api/jobs/:id/events` | 可选 `after` 查询参数或 `Last-Event-ID` 请求头 | 带递增 ID 的 SSE，执行完成/失败/暂停发送 `end` | 404 无权限，无 JSON 正文 |
| `POST /api/jobs/:id/verification` | `{kind,x,y}` | `{ok:true}` | 400 非法坐标；404 无权限；409 无待验证任务；429 输入过快 |
| `POST /api/jobs/:id/pause` | 无 | `{jobId,status}` | 404 无权限；409 非学习任务或已结束 |
| `POST /api/jobs/:id/resume` | 无 | `{jobId,status:"queued"}` | 404 无权限；409 尚未暂停或已结束 |
| `GET /api/stats` | 无 | `{queued,jobs,accounts}` | — |

`/api/stats` 只统计**当前访客自己的**任务（`queued` 与 `jobs` 按 `visitor_id` 过滤），账号数量也是当前访客的，
不包含他人 UID、任务数量或任务内容。早期版本返回的是实例总量，属于跨访客信息暴露，已修正。

## 账号与积分

账号数组元素为：

```json
{
  "uid": "示例账号",
  "nick": "示例昵称",
  "expires_at": 0,
  "created_at": 1793923200000,
  "last_run_at": 0,
  "last_score": {"today": 1, "total": 101, "tasks": {"9": {"name": "每日登录", "done": 1, "max": 1}}},
  "active_job": null,
  "active_job_status": null
}
```

`last_score` 在北京时间跨日后可为 null，不代表今日得分为零；应主动查询。客户端不接收封存 Cookie、登录备份或浏览器 profile。

任务代码可接受 `login`、`article`、`video`、`daily`、`weekly`、`special`。系统在界面显示中文；官方清单没有开放的任务不应被视作可获得积分的承诺。

```json
{"tasks":["login","article","video","daily"]}
```

未提供任务或空数组时，HTTP 接口沿用默认四项任务。同账号已有活跃任务时返回原任务，不新建；`reused:true` 时返回的 tasks 是本次请求参数，实际执行以原任务为准。入队成功不是任务完成，必须等待事件终态并核对官方积分。

每周自动计划的页面、接口和触发器均已移除，`GET/PUT /api/schedule` 返回 404。旧记录仅为历史兼容保留，未执行的历史计划任务会被停止；手动任务与“每周答题”题型保留。

## 暂停与继续

暂停当前账号的学习任务：queued 立即成为 paused；running 先成为 pausing，执行器在当前页面操作返回或停留/答题等待的检查点退出，关闭账号会话后成为 paused，释放执行名额。pausing 不允许继续，防止旧浏览器尚未关闭时同账号再次执行。paused 继续后重新排队并回查官方进度，已获得积分保留；未完成材料或题目可能重新进入。

paused/pausing 仍是未结束任务，重复提交返回原任务及 status，不能解绑。刷新或更换标签页可读取 active_job_status 恢复按钮状态。暂停不是失败；终态为 failed 的风险任务不能使用 resume。账号转移时原访客暂停任务失效，不会阻塞新访客。

## 事件协议

任务事件示例（时间和积分仅为样例）：

```text
id: 42
data: {"type":"step","payload":{"text":"▶ 开始 每日答题"}}

id: 43
data: {"type":"score","payload":{"today":1,"total":101,"tasks":{}}}

event: end
data: {"status":"done","error":null}

```

普通事件包括 `start`、`step`、`log`、`ok`、`bad`、`score`、`done`、`error`、`verification`、`verification-end`。界面使用 `end` 判断是否关闭任务流，status 可为 done、failed 或 paused；历史超过 200 条时分批回放，不跳过终态前事件。权限在建立连接和每次轮询时检查。

登录事件包括 `qr`（`payload.code`）、`done`（`uid,nick,score`）、`failed`（`error`）；二维码图片另向登录状态端点获取。登录流当前不提供任务流相同的事件游标/终态关闭协议，客户端在成功或失败后关闭连接。

`verification` 包含 `{image,width,height}`：image 是 JPEG base64。用户在实时画面亲自操作，前端将坐标缩放到原图尺寸，发送 `down`、`move`、`up`；坐标必须有限且在闭区间 `[0,width] × [0,height]`。不提供自动解验证码端点。

## 错误与运行边界

受业务控制的失败使用 `{error:"中文说明"}`。任务内原始诊断保存在数据库错误字段，向前端发送时转换中文并移除调用栈。API 当前没有统一处理所有 Express 解析异常和未知路由的 JSON 中间件，不能假设任意错误均为 JSON；前端 `api()` 已保留非 JSON 错误回退。该项作为后续 HTTP 边界改进记录，不改变本轮旧契约。

SSE 不应被反向代理缓冲；Nginx 需设置长读取超时。健康检查的 workers 必须大于零才表明有近期心跳，不保证第三方平台可访问或账号有效。内存限流是单 API 进程范围；多 API 扩容前必须替换共享限流。
