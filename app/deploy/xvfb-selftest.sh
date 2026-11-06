#!/usr/bin/env bash
# 在容器里验证 Xvfb 方案：虚拟显示 + 原生 Chromium + xdotool(XTest) 能不能把滑块拖到终点。
# 不接触学习强国账号，只用本地构造的模拟验证码页面。
#
# 在服务器上跑（不动正式容器，用完即弃）：
#   docker compose -f compose.yml -f compose.server.yml -f compose.instance.yml \
#     run --rm --entrypoint bash worker /app/deploy/xvfb-selftest.sh
#
# 本机 Linux 直接跑：
#   bash deploy/xvfb-selftest.sh
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1; }

if ! need Xvfb || ! need xdotool; then
  echo "== 安装 Xvfb / xdotool =="
  if need apt-get; then
    apt-get update -qq && apt-get install -y -qq --no-install-recommends xvfb xdotool >/dev/null
  else
    echo "缺少 Xvfb 或 xdotool，且没有 apt-get" >&2
    exit 2
  fi
fi

export DISPLAY=:99
echo "== 启动 Xvfb =="
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1.2
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "Xvfb 启动失败：" >&2; cat /tmp/xvfb.log >&2; exit 3
fi

cleanup() { kill "$XVFB_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "== 运行自检（原生 Chromium + xdotool）=="
# 复用已启动的 Xvfb：脚本内部不再自己拉一个
node deploy/xvfb-selftest.mjs
RC=$?
echo "== 自检退出码 $RC =="
exit $RC
