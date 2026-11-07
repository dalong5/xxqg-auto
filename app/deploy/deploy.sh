#!/usr/bin/env bash
# 服务器端部署脚本：保留数据卷与密钥，只替换源码并重建镜像/容器。
# 用法（在服务器上）：
#   tar xzf xxqg-release-<VER>.tar.gz -C /opt/xxqg-auto/releases/<VER>
#   bash /opt/xxqg-auto/releases/<VER>/deploy.sh <VER>
set -euo pipefail

VER="${1:?用法: deploy.sh <版本号>}"
APP_DIR=/opt/xxqg-auto/app
REL_DIR="/opt/xxqg-auto/releases/${VER}"
DATA_VOL=xxqg_xxqg-data
PROJECT=xxqg
COMPOSE_FILES=(-f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/compose.server.yml" -f "$APP_DIR/compose.instance.yml")

# 保留 Xvfb（虚拟显示）：上次部署如果给 worker 设了 DISPLAY，这次也要继续带上，
# 否则 worker 会退回 headless，验证码的「真实鼠标」那一档就失效了。
# 显式关闭：SKIP_XVFB=1；显式开启：WITH_XVFB=1
XVFB_ACTIVE=0
if [ "${WITH_XVFB:-0}" = "1" ]; then
  XVFB_ACTIVE=1
elif [ "${SKIP_XVFB:-0}" != "1" ] && [ -f "$APP_DIR/compose.xvfb.yml" ]; then
  # 直接按 compose 标签找 worker 容器：不依赖 compose 解析，最稳
  for cid in $(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=worker" --format '{{.ID}}'); do
    if docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^DISPLAY='; then
      XVFB_ACTIVE=1
      break
    fi
  done
fi
if [ "$XVFB_ACTIVE" = "1" ]; then
  COMPOSE_FILES+=(-f "$APP_DIR/compose.xvfb.yml")
fi
# 日志轮转覆盖（存在就带上，否则容器日志会无限增长写满磁盘）
if [ -f "$APP_DIR/compose.logging.yml" ]; then
  COMPOSE_FILES+=(-f "$APP_DIR/compose.logging.yml")
  echo "已启用日志轮转：compose.logging.yml"
fi

log() { printf '\n== %s ==\n' "$*"; }

log "0. 预检"
command -v docker >/dev/null || { echo "docker 不存在"; exit 2; }
[ -d "$APP_DIR" ] || { echo "找不到 $APP_DIR"; exit 2; }
[ -d "$REL_DIR/app" ] || { echo "找不到 $REL_DIR/app（解包目录不对？）"; exit 2; }
docker volume inspect "$DATA_VOL" >/dev/null || { echo "数据卷 $DATA_VOL 不存在"; exit 2; }

log "1. 备份数据库与密钥（卷内 backups/，数据库直接压缩省磁盘）"
docker run --rm -v "$DATA_VOL:/data" -v "$REL_DIR/backup:/backup" alpine:3 sh -c \
  "mkdir -p /backup && cp -a /data/app.db /backup/app.db 2>/dev/null && gzip -9 /backup/app.db; \
   cp -a /data/secret.key /backup/ 2>/dev/null; \
   [ -d /data/profiles ] && tar czf /backup/profiles.tgz -C /data profiles || true; ls -lh /backup"
# 恢复时：gunzip /backup/app.db.gz（WAL 模式下先停容器再覆盖）

log "2. 给当前镜像打回滚标签"
for img in xxqg-api xxqg-worker; do
  if docker image inspect "$img:latest" >/dev/null 2>&1; then
    docker tag "$img:latest" "$img:pre-${VER}" || true
    echo "tagged $img:latest -> $img:pre-${VER}"
  fi
done

log "2.5 等运行中的任务结束（重建容器会打断它，被打断的任务会重跑）"
count_running() {
  docker run --rm -v "$DATA_VOL:/data" alpine:3 sh -c \
    'command -v sqlite3 >/dev/null 2>&1 || (apk add -q sqlite >/dev/null 2>&1); sqlite3 /data/app.db "select count(*) from jobs where status in (\"running\",\"pausing\")" 2>/dev/null || echo 0' | tr -dc '0-9'
}
WAIT_SECONDS="${WAIT_RUNNING_SECONDS:-600}"
waited=0
while :; do
  running=$(count_running)
  [ -z "$running" ] && running=0
  if [ "$running" = "0" ]; then echo "没有运行中的任务，继续"; break; fi
  if [ "${FORCE_DEPLOY:-0}" = "1" ]; then echo "有 $running 个任务在跑，FORCE_DEPLOY=1 强制继续"; break; fi
  if [ "$waited" -ge "$WAIT_SECONDS" ]; then
    echo "还有 $running 个任务在跑，等了 ${waited}s 仍未结束。"
    echo "可以等任务自然结束再部署，或 FORCE_DEPLOY=1 强制打断（被打断的任务会从头重跑）。"
    exit 4
  fi
  sleep 15
  waited=$((waited + 15))
  echo "有 $running 个任务在跑，已等 ${waited}s / ${WAIT_SECONDS}s"
done

log "3. 替换源码（保留 compose/data/.env）"
tar czf "/opt/xxqg-auto/releases/${VER}/previous-source.tar.gz" -C "$APP_DIR" --exclude=data --exclude=node_modules . || true
rsync -a --delete --exclude data --exclude node_modules --exclude .env \
  --exclude compose.instance.yml --exclude compose.xvfb.yml \
  "$REL_DIR/app/" "$APP_DIR/"

log "4. 重建并滚动重启（Xvfb=$([ "$XVFB_ACTIVE" = 1 ] && echo 开启 || echo 关闭)）"
cd "$APP_DIR"
docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" build
docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" up -d

log "5. 等待健康"
healthy=0
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8099/healthz >/dev/null 2>&1; then echo "healthz ok"; healthy=1; break; fi
  sleep 3
done
if [ "$healthy" != "1" ]; then
  echo "健康检查超时，尝试回滚到 pre-${VER}"
  docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" ps
  if docker image inspect "xxqg-api:pre-${VER}" >/dev/null 2>&1; then
    docker tag "xxqg-api:pre-${VER}" xxqg-api:latest
    docker tag "xxqg-worker:pre-${VER}" xxqg-worker:latest 2>/dev/null || true
    docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" up -d --no-build
    for i in $(seq 1 20); do
      if curl -fsS http://127.0.0.1:8099/healthz >/dev/null 2>&1; then
        echo "已回滚到 pre-${VER}，服务恢复"; exit 5
      fi
      sleep 3
    done
    echo "回滚后仍不健康，需要人工介入（数据卷未改动）"; exit 5
  fi
  echo "没有 pre-${VER} 镜像，无法自动回滚；用 $REL_DIR/previous-source.tar.gz 重建："
  echo "  tar xzf $REL_DIR/previous-source.tar.gz -C $APP_DIR && cd $APP_DIR && docker compose ${COMPOSE_FILES[*]} --project-name $PROJECT build && docker compose ${COMPOSE_FILES[*]} --project-name $PROJECT up -d"
  exit 3
fi

log "6. 校验"
curl -fsS http://127.0.0.1:8099/healthz; echo
curl -fsS http://127.0.0.1:8099/api/me; echo
docker run --rm -v "$DATA_VOL:/data" alpine:3 sh -c 'ls -l /data/secret.key; sqlite3 /data/app.db "select count(*) from users" 2>/dev/null || true'
docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" ps
if [ "$XVFB_ACTIVE" = "1" ]; then
  for c in $(docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" ps -q worker); do
    name=$(docker inspect "$c" --format '{{.Name}}')
    disp=$(docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^DISPLAY=' | head -1)
    echo "worker $name ${disp:-DISPLAY=(未设置，Xvfb 没生效！)}"
  done
fi

log "7. 公网自检"
curl -fsS -o /dev/null -w 'https=%{http_code}\n' https://1.14.105.129/ || echo "公网检查失败（可能证书/网关）"

log "8. 清理悬空镜像（不动 latest / 回滚标签）"
docker image prune -f 2>&1 | tail -1

cat <<EOF

部署完成：$VER
如需回滚（pre-$VER 镜像标签；若已缺失，用发布包源码重建）：
  cd $APP_DIR && docker compose ${COMPOSE_FILES[*]} --project-name $PROJECT build
  或：docker tag xxqg-api:pre-$VER xxqg-api:latest && docker tag xxqg-worker:pre-$VER xxqg-worker:latest
  cd $APP_DIR && docker compose ${COMPOSE_FILES[*]} --project-name $PROJECT up -d --no-build
  数据库/密钥备份在卷内 backups/${VER}/，不要用旧库覆盖新积分。
EOF
