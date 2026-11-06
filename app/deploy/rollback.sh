#!/usr/bin/env bash
# 回滚到 pre-<VER> 镜像（不动数据卷、不覆盖数据库）
set -euo pipefail
VER="${1:?用法: rollback.sh <版本号>}"
APP_DIR=/opt/xxqg-auto/app
COMPOSE_FILES=(-f "$APP_DIR/compose.yml" -f "$APP_DIR/compose.server.yml" -f "$APP_DIR/compose.instance.yml")

docker tag "xxqg-api:pre-${VER}" xxqg-api:latest
docker tag "xxqg-worker:pre-${VER}" xxqg-worker:latest
cd "$APP_DIR"
docker compose "${COMPOSE_FILES[@]}" --project-name xxqg up -d --no-build
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8099/healthz && break
  sleep 2
done
docker compose "${COMPOSE_FILES[@]}" --project-name xxqg ps
echo "已回滚到 pre-${VER}；数据卷与密钥未改动。"
