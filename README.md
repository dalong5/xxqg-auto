# 学习站点：多账号网页登录与任务

学习强国扫码登录、积分查询和网页任务执行器。支持绑定多个账号、切换查看积分与任务；安全验证仍需要用户亲自处理。

本地架构与重构交付（2026-11-06）：[交付入口](docs/MVP-DELIVERY.md)、[架构/目录/数据表/缓存](docs/ARCHITECTURE.md)、[API 契约](docs/API.md)、[问题与修复证据](docs/REFACTOR-REVIEW.md)。完整代码在 `app/`；本轮未推送或部署，不代表公开运营验收完成。

## 本次合并保留的本地新增（2026-11-07）

合并 `codex/reliable-single-account-20261103`（多账号、暂停/继续、部署文档）时，以下两条本地能力被完整保留并接入：

1. **滑块缺口自动解码**（`platform/src/domain/captcha/`）：拼图块与背景做 alpha 包围盒 + 二维像素匹配求出真实缺口，再按 ease-out 轨迹拖动。
   - 已接入 `app/src/xxqg/browser.js::clearCaptcha()`：**先自动解码，通过即返回；不通过才进入原来的人工验证通道**（人工通道逻辑一行未改）。
   - 文档：[platform/docs/CAPTCHA.md](platform/docs/CAPTCHA.md)；测试：`platform/test/slider.test.mjs`、`platform/test/captcha-e2e.test.mjs`（真实浏览器 + 模拟阿里云 DOM，误差 ≤3px）。
2. **无 CDP 普通 Chrome 通道**（`app/src/xxqg/plain.js` + `app/scripts/native.ps1`）：预置 cookie 到独立 profile，用地址栏 `javascript:void(...)` 探针读页面、OS 级鼠标点击/拖拽，用于 CDP 被风控拦下的场景。当前是可选模块，未接入默认任务流。
3. **产品化 MVP**（`platform/`）：独立的 API+Worker 架构、8 张表、SSE 日志、定时、多租户额度，30 项测试；与 `app/` 共用同一套缺口解码器。


## 当前能力

| 功能 | 实际状态 |
| --- | --- |
| APP 扫码登录 | 已实测，密钥一致时可复用登录态；失效后可重新扫码 |
| 完整积分清单 | 已实现，使用手机端清单，动态读取每项上限 |
| 网页登录、阅读、视听 | 已有执行器；2026-11-03 账号回查分别为 1/1、12/12、12/12 |
| 每日答题 | 2026-11-03 真实运行并回查确认 5/5，当天积分 27 → 32 |
| 验证码接手 | 网站展示实时画面，转发用户亲自操作；超时失败 |
| 趣味答题 | 只支持进度查询；官方页面依赖 APP 原生桥，未验证出纯浏览器执行路径 |
| 发表观点、本地频道 | 只支持进度查询；未找到可用纯浏览器执行入口 |
| 每周、专项答题 | 有历史代码，当前账号清单未开放，未做真实执行验证 |
| 多账号 | 每个浏览器默认绑定 10 个；服务器同时执行 2 个账号，同一账号串行，其他排队 |
| HTTPS 服务器部署 | Docker + Nginx，网站直接访问，学习账号仍需扫码，见 [服务器部署](docs/SERVER-DEPLOYMENT.md) |
| 定时无人值守、长期多人运营 | 未验证 |

最新状态和下一步请读 [docs/HANDOFF.md](docs/HANDOFF.md)。运行说明见 [app/README.md](app/README.md)，验证与已知风险见 [docs/WORKFLOW-VERIFICATION.md](docs/WORKFLOW-VERIFICATION.md)。

## 快速启动

需要 Node 24 和本机 Chrome。

```powershell
cd app
npm ci
Copy-Item .env.example .env
npm run dev
```

默认访问 http://127.0.0.1:8099/。本次机器因 8099 被其他服务使用，在未入库的 .env 设置 PORT=8101，访问 http://127.0.0.1:8101/。

Windows 独立后台运行：在 app 下执行 powershell -NoProfile -File scripts/start-background.ps1；停止时加 -Stop。该脚本不配置开机自启，也不运行自动学习计划。

## 维护原则

积分必须从平台回查；点击按钮或结束循环不算成功。不得写死每日总上限，不得将 APP 任务显示成可自动执行。

主账号 cookie 使用 AES-256-GCM 加密。按仓库既有约定，登录表保留 7 天明文恢复备份，浏览器 profile 也可能包含登录态，因此整个 data 目录必须按密码保管。data、.env、密钥、账号信息与调试截图不得入库。

测试：app 下运行 npm test 和 npm run test:smoke。端到端测试使用临时数据库和随机端口，不操作真实账号。
