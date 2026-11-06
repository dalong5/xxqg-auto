FROM node:24-bookworm-slim

# Chromium + 中文字体：页面要真实渲染，缺字体中文会变方块
# xvfb / xdotool：可选虚拟显示，让 OS 级鼠标（XTest）在容器里可用；
#   只影响启用 compose.xvfb.yml 的部署，不启用时它们只是多占约 20MB 镜像。
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-noto-cjk \
      xvfb xdotool procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_CHANNEL= \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8099

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

EXPOSE 8099
CMD ["node", "src/server.js"]
