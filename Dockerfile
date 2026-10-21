# syntax=docker/dockerfile:1

# Playwright ships the browser binaries that match the npm package exactly.
# The version MUST stay in sync with the `playwright` dependency in
# package.json — a mismatch makes Chromium fail to launch with
# "Executable doesn't exist at /ms-playwright/chromium-*/chrome-linux/chrome".
# `npm run docker:verify` checks that; CI runs it on every build.
ARG PLAYWRIGHT_VERSION=1.60.0
ARG NODE_VERSION=22.22.0
ARG APP_VERSION=dev

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG APP_VERSION
LABEL org.opencontainers.image.title="qwenproxy" \
      org.opencontainers.image.description="OpenAI-compatible proxy for Qwen (chat.qwen.ai) via Playwright" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/pedrofariasx/qwenproxy" \
      org.opencontainers.image.licenses="ISC"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# dumb-init gives us correct signal handling (PID 1 reaping + SIGTERM
# forwarding); gosu drops the root privileges without breaking the
# setuid semantics of `su`.
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init gosu tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Backend dependencies (cached layer) -------------------------------------
# package-lock.json is required: `npm ci` is reproducible and fails loudly
# when the lockfile is out of sync with package.json.
# `--include=dev` is explicit so the build never depends on the ambient
# NODE_ENV (npm silently drops devDependencies when it is "production").
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-fund --no-audit && npm cache clean --force

# --- Backend build -----------------------------------------------------------
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN npm run build && npm prune --omit=dev

# --- Admin dashboard build ---------------------------------------------------
# The dashboard is a separate npm workspace; its output is served from
# web/dist by the API server.
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci --include=dev --no-fund --no-audit
COPY web/ ./web/
RUN npm --prefix web run build && rm -rf web/node_modules

# --- Runtime layout ----------------------------------------------------------
# The two directories below hold everything that must survive a container
# replacement: the SQLite database and the per-account browser profiles.
RUN mkdir -p /app/data /app/qwen_profiles /tmp/playwright \
    && chown -R pwuser:pwuser /app /tmp/playwright \
    && chmod +x /app/docker-entrypoint.sh

# NODE_ENV is set only now: the build above needs the devDependencies.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

VOLUME ["/app/data", "/app/qwen_profiles"]

EXPOSE 3000

# Graceful shutdown: the server drains in-flight streams before exiting.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
