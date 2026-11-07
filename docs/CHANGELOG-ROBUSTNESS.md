# 稳定性修复清单（2026-11-08 夜间巡检）

一晚上连续巡检出来的问题与修法，按影响从大到小排列。每条都有测试或线上验证，
发布版本见 `docs/TENCENT-DEPLOYMENT.md` 的版本记录。

## 会直接丢分 / 让功能失效

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | 滑块手柄被当成关闭按钮 | 拖动距离算成 21px（实际 321px），必失败 | 用真实 DOM 的 `.aliyunCaptcha-sliding-slider` 量尺寸 |
| 2 | 通过后仍被判失败 | 已经过了还重拖，把状态拖坏 | 三条件判定（`passed` 文本 / `closed` / 位移 > 60%） |
| 3 | 人工验证帧尺寸取 `viewportSize()` | 有头模式返回 `null`，前端点击坐标算成 NaN，**人工验证完全点不动** | 新 `frameSize(page)` 用 `innerWidth/innerHeight` |
| 4 | 点选填空退化匹配按前缀截断 | 词块错位，整题填错 | `pickChip()` 从匹配位置移除子串 |
| 5 | 答题提示弹层没渲染就读 | 拿到空答案 → 乱选 | 等弹层 `visible` + 空则补点一次 |
| 6 | `DAILY_WAIT_MIN=abc` 之类脏配置 | `NaN` → `setTimeout(NaN)` 立即作答，最易触发风控 | `dailyWaitSeconds()` 走 `positiveInt` 回落 20–60 |
| 7 | 扫码换码后不重新计时 | 第一张码过期后新码只剩几十秒，越换越扫不上 | `nextQrDeadline()`：每码 150s，整场封顶 300s |
| 8 | 重复抽到同一篇文章 | 重复阅读不计分，白等 60s | 洗牌后按队列取 |

## 会让任务/接口挂掉

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 9 | 任务卡在无超时的 `page.evaluate` | 心跳正常、`docker ps` 正常，job 永远 running | 看门狗：本执行器名下 10 分钟无事件 → `failJob` + 关浏览器 |
| 10 | 单任务失败直接 `throw` | 阅读差 1 分就整轮中断，连每日答题都不跑 | 普通失败记录后继续；风控/401 才中止 |
| 11 | 多处 `JSON.parse` 库字段 | 一条半截数据 → `/api/users` 500；SSE 在 `setInterval` 里抛错 → **进程退出** | `util.parseJson(value, fallback)` |
| 12 | async 路由没兜底 | Express 4 不捕获，Node 24 未处理 rejection 直接退进程 | `asyncRoute()` + 4 参数错误中间件 |
| 13 | 前端 SSE 直接 `JSON.parse` | 一条坏帧抛 TypeError、丢日志 | try/catch + 可选链 |
| 14 | 登录 SSE `onerror` 直接 close | 抖一下界面就停在旧二维码 | 保留自动重连，CLOSED 才提示重扫 |
| 15 | 扫码轮询/建码/授权无重试 | 网络抖一次就要重新扫码 | `retryTransient`（只重试瞬时错误） |

## 资源与容量

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 16 | 验证码截图全存库 | 数据库 193MB（本地 133MB） | 只留最近 3 帧 + 自动通过即清 + 清理脚本 |
| 17 | `/api/selftest` 无去重 | 可无限入队，每次拉起一个浏览器 | 按访客复用 + 3 次/5 分钟限流 |
| 18 | 限流 Map 只增不减 | 长跑内存泄漏 | 过期清理 + 2000 key 上限 |
| 19 | 配置项 `Number()` 得 `NaN` | 上限判断恒 false（如 `MAX_ACCOUNTS` 失效） | `positiveInt()` 统一回落 |
| 20 | `/api/stats` 全表统计 | 任何访客都能看到别人的队列/任务数 | 按 `visitor_id` 过滤 |

## 部署与运维

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 21 | 部署打断运行中的任务 | 用户进度白丢（被打断的任务会重跑） | `deploy.sh` 等任务结束（默认 600s，`FORCE_DEPLOY=1` 可强制） |
| 22 | 部署失败停在坏状态 | 服务一直不可用等人处理 | 健康检查失败自动回滚 `pre-<VER>`，并留档 `pre-rollback-<时间戳>` |
| 23 | `docker ps` 显示 Up ≠ 接口可用 | 看不出 DB/事件循环问题 | api 容器 healthcheck（`node fetch /healthz`） |
| 24 | `rollback.sh` 引用不存在的 `compose.yml` | 真出故障时回滚直接报错 | 改对文件名 + 带上 logging/xvfb + 找不到镜像时给出方案 |
| 25 | `deploy.sh` 版本号传空 | `rm -rf` 会删掉整个 releases 目录 | 去空白校验，空则 `exit 2` |
| 26 | `releases` 目录权限 700 | ubuntu 用户进不去，解压/排查全失败 | 启动时 `chmod 755` 自愈 |
| 27 | 清理脚本 VACUUM 静默失败 | 定时任务没缩容但看不出来 | `busy_timeout` + 失败退出码 1 + 报告 WAL 大小 |

## 明确的边界（不是 bug，但要知道）

- **订阅 / 发表观点 / 趣味答题 / 本地频道 / 强国运动是 App 独有任务**，PC 网页没有入口，
  自动化拿不到这 2+1+10+1+2 分，详见 `docs/APP-ONLY-TASKS.md`。
- 风控引擎仍可能拒绝**正确**的拖动；自动通过只验证过 1 次真实样本。
- 每日答题每题等待 20–60 秒是刻意的防封号策略，不是性能问题。
