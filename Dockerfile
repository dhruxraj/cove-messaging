# syntax=docker/dockerfile:1.7
# Cove — production image: API server + built web client + ffmpeg for media validation.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
# Only the server's runtime dependencies are needed (the web client is prebuilt static files).
RUN if [ -f package-lock.json ]; then npm ci --omit=dev -w server; else npm install --omit=dev -w server; fi \
 && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /app/server
ENV PORT=8080 \
    STORAGE_DIR=/data/storage \
    WEB_DIST_DIR=/app/web/dist
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Migrations run automatically at start-up (guarded by an advisory lock). Set RUN_MIGRATIONS=false
# and run `node dist/migrate.js` separately if you prefer an explicit migration step.
CMD ["node", "dist/index.js"]
