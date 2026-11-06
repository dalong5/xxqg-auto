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

log() { printf '\n== %s ==\n' "$*"; }

log "0. 预检"
command -v docker >/dev/null || { echo "docker 不存在"; exit 2; }
[ -d "$APP_DIR" ] || { echo "找不到 $APP_DIR"; exit 2; }
[ -d "$REL_DIR/app" ] || { echo "找不到 $REL_DIR/app（解包目录不对？）"; exit 2; }
docker volume inspect "$DATA_VOL" >/dev/null || { echo "数据卷 $DATA_VOL 不存在"; exit 2; }

log "1. 备份数据库与密钥（卷内 backups/）"
docker run --rm -v "$DATA_VOL:/data" -v "$REL_DIR/backup:/backup" alpine:3 sh -c \
  "mkdir -p /backup && cp -a /data/app.db /data/secret.key /backup/ 2>/dev/null; \
   [ -d /data/profiles ] && tar czf /backup/profiles.tgz -C /data profiles || true; ls -l /backup"

log "2. 给当前镜像打回滚标签"
for img in xxqg-api xxqg-worker; do
  if docker image inspect "$img:latest" >/dev/null 2>&1; then
    docker tag "$img:latest" "$img:pre-${VER}" || true
    echo "tagged $img:latest -> $img:pre-${VER}"
  fi
done

log "3. 替换源码（保留 compose/data/.env）"
tar czf "/opt/xxqg-auto/releases/${VER}/previous-source.tar.gz" -C "$APP_DIR" --exclude=data --exclude=node_modules . || true
rsync -a --delete --exclude data --exclude node_modules --exclude .env \
  --exclude compose.instance.yml --exclude compose.xvfb.yml \
  "$REL_DIR/app/" "$APP_DIR/"

log "4. 重建并滚动重启"
cd "$APP_DIR"
docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" build
docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" up -d

log "5. 等待健康"
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8099/healthz >/dev/null 2>&1; then echo "healthz ok"; break; fi
  sleep 3
  [ "$i" = 40 ] && { echo "健康检查超时"; docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" ps; exit 3; }
done

log "6. 校验"
curl -fsS http://127.0.0.1:8099/healthz; echo
curl -fsS http://127.0.0.1:8099/api/me; echo
docker run --rm -v "$DATA_VOL:/data" alpine:3 sh -c 'ls -l /data/secret.key; sqlite3 /data/app.db "select count(*) from users" 2>/dev/null || true'
docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" ps

log "7. 公网自检"
curl -fsS -o /dev/null -w 'https=%{http_code}\n' https://1.14.105.129/ || echo "公网检查失败（可能证书/网关）"

cat <<EOF

部署完成：$VER
如需回滚：
  docker tag xxqg-api:pre-$VER xxqg-api:latest && docker tag xxqg-worker:pre-$VER xxqg-worker:latest
  cd $APP_DIR && docker compose ${COMPOSE_FILES[*]} --project-name $PROJECT up -d --no-build
  数据库/密钥备份在卷内 backups/${VER}/，不要用旧库覆盖新积分。
EOF
