FROM node:22-bookworm-slim

# Chromium + 中文字体：页面要真实渲染，缺字体中文会变方块
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_CHANNEL= \
    DATA_DIR=/data \
    PORT=8099

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

EXPOSE 8099
CMD ["node", "src/server.js"]
