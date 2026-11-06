# MVP 代码与设计交付

2026-11-06，基于现有多账号任务站的本地重构版本。适用于小规模受控运行，不等同于公开运营、无人值守或第三方积分成功率的验收。

## 交付物

| 请求 | 对应交付 |
| --- | --- |
| 架构、组件、目录、数据流、数据库 Schema、缓存、扩容 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| API 端点、请求响应、授权、事件与错误契约 | [API.md](API.md) |
| 功能说明、故障、根因、边界、冗余与性能问题、重构方案及证据 | [REFACTOR-REVIEW.md](REFACTOR-REVIEW.md) |
| UI 架构与完整界面 | `app/public/index.html`；架构文档的组件/缓存章节 |
| 完整 API、任务执行器、持久化与测试代码 | `app/src/`、`app/test/`，不是片段或另一个演示项目 |
| 实施步骤 | [实施计划](superpowers/plans/2026-11-06-mvp-refactor.md) |
| 当前服务器运维历史 | [TENCENT-DEPLOYMENT.md](TENCENT-DEPLOYMENT.md)，不表示本轮已发布 |

## 本地运行

安装 Node 24 和 Chrome，在 `app/` 下执行：

```powershell
npm ci
Copy-Item .env.example .env # 仅首次；不要覆盖现有 .env
npm run dev
```

默认地址为 `http://127.0.0.1:8099/`。本机已有服务的 `.env` 使用 8101，本轮不自动重启其任务进程。API 和 worker 必须读取相同密钥及数据目录。

独立启动入口为 `npm run api` 和 `npm run worker`。`src/app.js` 可导入并监听测试临时端口，不自动注册进程退出处理；正常部署仍运行 `src/server.js`。

## 验证

```powershell
npm test
npm run test:smoke
```

完整回归覆盖隔离数据和模拟第三方适配器；端到端会访问官方登录页获取二维码并做浏览器自检，但不登录真实账号。验证画面测试使用自建夹具，不代表真实验证码已被自动解决。

## 生产运行条件

1. HTTPS 入口及 Secure/HttpOnly Cookie，Nginx 不缓冲 SSE，API 不直接暴露公网。保留既有无用户名/密码访问方案。
2. API 与 worker 共用本机持久化数据卷，禁止将 SQLite WAL 放网络文件系统；执行器并发从 1 开始按内存调整。
3. 确认 `/healthz` 的 workers 大于零，观察队列、数据卷空间、容器内存和任务失败。HTTP 200 不是积分成功证明。
4. 保护整个 data 目录，包括主密钥、登录恢复备份和 profile；停止服务后做完整备份，在隔离环境演练恢复。
5. 发布前固定代码版本，保留旧镜像及数据备份；先等活跃任务自然完成。回滚代码不得覆盖较新的进度数据。
6. 公开开放或无人值守前，完成审查表中仍保留的安全/一致性问题、实际容量与第三方兼容性验收。本轮没有发布服务器、迁移真实数据或操作真实账号。

本轮不新增注册/支付/角色、跨服务器数据库、Redis、验证码规避或 APP 专属积分实现；这些内容不是目录或占位接口所能代表的已交付能力。
