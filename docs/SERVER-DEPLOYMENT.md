# 多账号服务器部署

2026-11-04 更新：compose.server.yml 为 API 和 worker 设置 MAX_ACCOUNTS=10，并将任务并发设为 2。同一账号继续串行，其他账号可同时运行；超出并发数自动排队。网页按账号切换积分、日志和验证画面，不同浏览器的账号列表保持隔离。

执行器编号加入每次进程启动生成的 UUID，避免容器复用 PID 1 时继承旧心跳，使中断任务无法被回收。进程中断后最多等待旧心跳失效约 110 秒，再领取原任务并重新回查积分。

部署使用 `codex/reliable-single-account-20261103` 分支。Node 24 与 Chromium 由 Dockerfile 安装；宿主机 Node 版本不影响容器。

```bash
cd app
cp .env.example .env
chmod 600 .env
docker compose -f docker-compose.yml -f compose.server.yml up -d --build
curl -fsS http://127.0.0.1:8099/healthz
```

需要支持 `!override` 的 Compose 2.24.4 或更新版本。服务器覆盖配置只把 8099 发布到回环地址，固定容器监听地址与端口。不要将 Windows 的 CHROME_PATH 配置带到容器。

Nginx 反向代理到 127.0.0.1:8099。2026-11-04 按用户要求取消网站 Basic Auth，直接打开网站即可；学习强国账号仍需 APP 扫码授权，账号列表与任务接口仍校验访客归属。匿名访问者可以生成二维码和启动浏览器自检。

当前 Nginx 配置保存于 `app/deploy/nginx.conf`，监听 8102，由 Instabox 端口网关提供 HTTPS。该配置用于网关后方的 HTTP 上游；独立公网服务器需要另行配置 TLS 证书和 HTTPS 监听。不要直接公开 API 的 8099 端口。

代理关闭 buffering/cache，读取超时为 3600s，并给 xxqg_v cookie 添加 secure、httponly、samesite=lax。修改配置后先执行 nginx -t，再热重载；不需要重启 API/worker。

## 最新验证（2026-11-04）

- 多账号本地回归 19 项通过；Linux 容器 18 项通过、1 项 Windows 专用测试跳过、0 失败。
- 容器端到端通过：官方二维码、登录页、人工验证转发、访客隔离、历史日志与任务恢复。
- 公网显示多账号页面，/api/me 返回 maxAccounts=10，实际 worker 日志确认任务并发 2。
- 升级后保留原账号及密钥；中断任务由新 UUID 执行器回收，attempts 增为 2，恢复 running。
- 公网浏览器自检及 SSE 完成通知通过。
- 移除网站访问密码后，无认证请求首页、/api/me、/healthz 均为 200，无 WWW-Authenticate 头，worker 在线。

多个真实账号同时计分、长期跨天运行尚未验证。服务器重建时需要重新发布 Nginx 端口；机器停机期间网站不可用。

## 首次部署记录（2026-11-03，访问密码状态已由上述更新替代）

- Debian x86_64、4 核 8GB、Docker Compose 5.6.0：镜像构建与启动成功。
- 公网 HTTPS：匿名 401，认证后页面/API 200，访客 cookie 带 Secure。
- 公网生成官方二维码、浏览器自检、SSE 接收任务完成状态成功。
- 容器内端到端测试通过：二维码、官方登录页、人工验证输入转发、访客隔离及日志恢复。
- 答题回归测试改为读取 CHROME_PATH，兼容容器 Chromium。

这些检查不包含服务器上的真实账号扫码授权、实际积分或跨天验证。APP 专属任务能力不随部署改变。

## 运维

```bash
docker compose -f docker-compose.yml -f compose.server.yml ps
docker compose -f docker-compose.yml -f compose.server.yml logs --tail=100 api worker
docker compose -f docker-compose.yml -f compose.server.yml restart
```

API 和 worker 共用 xxqg-data 卷及密钥。不要执行 `down -v` 或删除 secret.key；备份时先停止两个服务，再备份整个数据卷。数据库、浏览器状态及登录恢复备份均按密码保管。

容器配置 restart: unless-stopped；宿主机 Docker 需要开机启动。Instabox 停机期间公网地址不提供服务。
