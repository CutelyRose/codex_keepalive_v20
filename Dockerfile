FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /build/any
COPY any/package.json any/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY any/build.mjs any/index.html any/tsconfig.json ./
COPY any/src ./src
RUN npm run check && npm run build

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /app/any/data
WORKDIR /app
COPY codex_board.py codex_client.py codex_memory.py codex_mouse.py codex_notify.py codex_poll.py codex_tasks.py codex_ui.py ./
COPY --from=build /build/any/dist ./any/dist
COPY any/server.mjs any/python-bridge.mjs any/python_scheduler.py ./any/
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    ANYROUTER_HOST=0.0.0.0 \
    ANYROUTER_PORT=8787 \
    ANYROUTER_DATA_DIR=/app/any/data \
    TZ=Asia/Shanghai
USER node:node
WORKDIR /app/any
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.ANYROUTER_PORT + '/api/health', {signal: AbortSignal.timeout(4000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.mjs"]
