#!/usr/bin/env bash
# 容器入口包装：先起 Xvfb，再执行原来的 node 命令。
# 用途：让 worker 里有 DISPLAY，OS 级鼠标才能通过 XTest 注入（真实输入，不是 CDP 合成事件）。
set -euo pipefail

if command -v Xvfb >/dev/null 2>&1; then
  if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
    Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
    for _ in $(seq 1 30); do
      [ -e /tmp/.X11-unix/X99 ] && break
      sleep 0.2
    done
  fi
  export DISPLAY=:99
  echo "[entrypoint] Xvfb 就绪 DISPLAY=$DISPLAY"
else
  echo "[entrypoint] 未安装 Xvfb，回退为无桌面模式（不做 OS 级输入）" >&2
fi

exec "$@"
