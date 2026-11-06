# 生产镜像：两阶段（依赖层 / 运行层），非 root
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=8090 \
    DATA_DIR=/data
WORKDIR /app

# 时区：任务按本地时间调度
RUN apt-get update && apt-get install -y --no-install-recommends tzdata curl \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo Asia/Shanghai > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8090/healthz || exit 1

# 默认起 API；worker 用 compose 覆盖 command
CMD ["node", "src/index.js"]
