#!/usr/bin/env bash
# 一键：Xvfb 自检 → （通过才）部署 → 部署后校验；任一步失败就停，不碰数据卷。
#
# 在服务器上执行：
#   tar xzf /tmp/xxqg-release-<VER>.tar.gz -C /opt/xxqg-auto/releases/<VER>
#   bash /opt/xxqg-auto/releases/<VER>/app/deploy/server-update.sh <VER>
#
# 只跑自检不部署：
#   SKIP_DEPLOY=1 bash .../server-update.sh <VER>
set -euo pipefail

VER="${1:?用法: server-update.sh <版本号>}"
APP_DIR=/opt/xxqg-auto/app
SRC_DIR="/opt/xxqg-auto/releases/${VER}/app"
COMPOSE=(-f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/compose.server.yml" -f "$APP_DIR/compose.instance.yml")

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

log "0. 环境检查"
command -v docker >/dev/null || { echo "没有 docker"; exit 2; }
docker compose version >/dev/null || { echo "compose 不可用"; exit 2; }
[ -d "$SRC_DIR" ] || { echo "找不到 $SRC_DIR"; exit 2; }

log "1. Xvfb 自检（临时容器，不碰正式服务与账号）"
if docker compose "${COMPOSE[@]}" --project-name xxqg-selftest run --rm --no-deps \
      --entrypoint bash worker /app/deploy/xvfb-selftest.sh; then
  echo "自检 PASS：Xvfb + xdotool 能把滑块拖到终点"
  XVFB_OK=1
else
  echo "自检 FAIL：容器内 OS 级输入不可用，不建议启用 Xvfb 覆盖配置"
  XVFB_OK=0
fi

if [ "${SKIP_DEPLOY:-0}" = "1" ]; then
  log "SKIP_DEPLOY=1，到此为止"
  [ "$XVFB_OK" = "1" ] || exit 1
  exit 0
fi

log "2. 正式部署"
bash "$SRC_DIR/deploy/deploy.sh" "$VER"

log "3. 部署后校验"
curl -fsS http://127.0.0.1:8099/healthz; echo
docker compose "${COMPOSE[@]}" --project-name xxqg ps
docker run --rm -v xxqg_xxqg-data:/data alpine:3 sh -c 'ls -l /data/secret.key' || true
curl -fsS -o /dev/null -w '公网 https=%{http_code}\n' https://1.14.105.129/ || echo "公网检查失败"

log "完成"
cat <<EOF
版本 $VER 已部署。
- Xvfb 自检：$([ "$XVFB_OK" = "1" ] && echo 通过 || echo 未通过)
- 若要启用容器内虚拟显示（启用后才会走 OS 级鼠标）：
    cd $APP_DIR
    docker compose ${COMPOSE[*]} -f compose.xvfb.yml --project-name xxqg up -d --build
  关闭：
    cd $APP_DIR && docker compose ${COMPOSE[*]} --project-name xxqg up -d --force-recreate
- 回滚：
    bash $SRC_DIR/deploy/rollback.sh $VER
EOF
