# 发布包：20261107-captcha-detect

- 源码提交：`faf9940`（`master`，已推送）
- 包：`xxqg-release-20261107-captcha-detect.tar.gz`（76 个文件，0.09 MB）
- SHA256：`dd1e5d013cd329afdfb1882959aff823a45b66170e558e600319a563de50a369`
- 内容：`app/` 源码（不含 `research/`、`data/`、`node_modules`、`.env`）

## 本版变化

| 项 | 说明 |
| --- | --- |
| 验证码类型识别 | 区分「按住滑块拖到最右」（无缺口）与拼图缺口；前者按轨道几何算距离，后者才做像素匹配 |
| 失败可诊断 | 找不到手柄时 `dumpCaptchaDom()` 把容器节点清单写进日志 |
| 真实鼠标兜底 | `XXQG_HEADED=1` 可控有头；`native.ps1` 只对 Playwright 窗口发输入（Linux 容器无桌面，此路径不生效） |
| 依赖修正 | 验证码实现内置到 `app/src/xxqg/captcha/`，因为容器构建上下文只有 `app/`，原来跨包引用会导致镜像构建失败 |
| 部署脚本 | `app/deploy/deploy.sh`（备份→打回滚标签→替换源码→重建→健康检查→公网自检）、`rollback.sh` |

## 部署（在服务器上执行）

```bash
VER=20261107-captcha-detect
mkdir -p /opt/xxqg-auto/releases/$VER
tar xzf /tmp/xxqg-release-$VER.tar.gz -C /opt/xxqg-auto/releases/$VER
bash /opt/xxqg-auto/releases/$VER/app/deploy/deploy.sh $VER
```

脚本做的事：卷内备份 `app.db`/`secret.key`/`profiles` → 给 `xxqg-api`/`xxqg-worker` 打 `pre-$VER` 标签 → 备份旧源码 → `rsync` 覆盖（保留 `data/`、`.env`）→ `compose build && up -d` → 等 `/healthz` → 打印 `ps` 与公网自检。

## 回滚

```bash
bash /opt/xxqg-auto/releases/$VER/app/deploy/rollback.sh 20261107-captcha-detect
```

## 上线前的现实预期（别当成"免验证"）

- 服务器是 **Linux 无桌面容器**：`SendInput` 不存在，所以「真实鼠标」这一档在服务器上**不会生效**；自动解码只剩 CDP 合成拖动。
- 按本机实测，CDP 合成拖动大概率仍被判 F001；本版在服务器上的实际收益是**类型识别 + 失败原因可诊断**，人工验证通道保持不变。
- 想真正提高服务器通过率，需要给容器配虚拟显示（Xvfb + xdotool）或改到有桌面的执行器上跑；这属于架构变更，不在本版范围。

## 部署前待确认

本机没有服务器 SSH 私钥/密码（`ssh -o BatchMode root@1.14.105.129` → `Permission denied (publickey,password)`），所以我**没有实际执行部署**。提供私钥或密码后我可以按上面步骤跑完并做部署后校验（健康、账号/密钥一致、公网 HTTPS）。
