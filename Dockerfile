# API imajı. Coolify repodan bu dosyayı build eder (PLAN.md K15).

# --- build ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_ROOT=/data/storage \
    PATH=/app/node_modules/.bin:$PATH
# tini: PID 1 sinyalleri iletir ve zombi süreçleri toplar (Coolify `--init`
# vermez); SIGTERM → Nest'in kapanış kancaları (WebSocket'ler, LISTEN, havuz).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Dosya deposu (S08): Coolify'da kalıcı volume buraya bağlanır; boş volume
# bu klasörün sahipliğini (node) devralır.
RUN mkdir -p /data/storage && chown node:node /data/storage
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Açılışta migration (scripts/docker-entrypoint.sh, S16): dbmate artık
# `dependencies`'te; migration'lar ve parola betiği imaja girer.
COPY --chown=node:node db/migrations ./db/migrations
COPY --chown=node:node scripts/set-api-password.mjs scripts/docker-entrypoint.sh ./scripts/

# Root olmayan kullanıcı (resmî imajdaki `node`, uid 1000).
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
