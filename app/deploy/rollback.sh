#!/usr/bin/env bash
# 回滚到 pre-<VER> 镜像（不动数据卷、不覆盖数据库）
# 用法: bash rollback.sh <版本号>     例：bash rollback.sh 20261108-watchdog
set -euo pipefail

VER="${1:?用法: rollback.sh <版本号>}"
if [ -z "$(printf '%s' "$VER" | tr -d '[:space:]')" ]; then
  echo "版本号不能为空" >&2
  exit 2
fi

APP_DIR=/opt/xxqg-auto/app
PROJECT=xxqg
DATA_VOL=xxqg_xxqg-data

# 基础 compose 文件。注意 compose 文件名是 docker-compose.yml，不是 compose.yml
# （老脚本写错文件名，-f 指向不存在的文件会让 docker compose 直接报错退出）
COMPOSE_FILES=(-f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/compose.server.yml" -f "$APP_DIR/compose.instance.yml")
[ -f "$APP_DIR/compose.logging.yml" ] && COMPOSE_FILES+=(-f "$APP_DIR/compose.logging.yml")
# 回滚也要保留 Xvfb：否则 worker 退回 headless，验证码的「真实鼠标」那套失效
[ -f "$APP_DIR/compose.xvfb.yml" ] && COMPOSE_FILES+=(-f "$APP_DIR/compose.xvfb.yml")

if ! docker image inspect "xxqg-api:pre-${VER}" >/dev/null 2>&1; then
  echo "找不到镜像 xxqg-api:pre-${VER}" >&2
  echo "可选方案：" >&2
  echo "  1) 看现有标签：docker images | grep pre-" >&2
  echo "  2) 用发布包源码重建：tar xzf /opt/xxqg-auto/releases/<VER>.tar.gz -C $APP_DIR && cd $APP_DIR && docker compose ${COMPOSE_FILES[*]} --project-name $PROJECT build" >&2
  exit 3
fi

# 回滚前先把当前镜像留一份，避免"回滚后想再回来"没得可用
STAMP="$(date +%Y%m%d%H%M%S)"
docker tag xxqg-api:latest "xxqg-api:pre-rollback-${STAMP}" 2>/dev/null || true
docker tag xxqg-worker:latest "xxqg-worker:pre-rollback-${STAMP}" 2>/dev/null || true

docker tag "xxqg-api:pre-${VER}" xxqg-api:latest
docker tag "xxqg-worker:pre-${VER}" xxqg-worker:latest

cd "$APP_DIR"
docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" up -d --no-build

healthy=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8099/healthz >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done

docker compose "${COMPOSE_FILES[@]}" --project-name "$PROJECT" ps
if [ "$healthy" != "1" ]; then
  echo "回滚到 pre-${VER} 后健康检查仍未通过，需要人工介入；数据卷与密钥未改动。" >&2
  exit 4
fi
curl -fsS http://127.0.0.1:8099/healthz; echo
echo "已回滚到 pre-${VER}（回滚前的镜像留档：pre-rollback-${STAMP}）；数据卷与密钥未改动。"
