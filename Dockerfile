FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps apps
RUN npm run build --workspaces
RUN npm prune --omit=dev --workspaces

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl ffmpeg nginx \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=8333 \
    WEB_ORIGIN=http://localhost:5333 \
    DATABASE_PATH=/data/video-manager.db \
    VSR_API_URL=http://host.docker.internal:8332 \
    VIDEO_UNPROCESSED_DIR=/videos/unprocessed \
    VIDEO_PROCESSING_DIR=/data/processing \
    VIDEO_ARCHIVED_DIR=/videos/archived \
    VIDEO_PROCESSED_DIR=/videos/processed

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /usr/local/bin/video-manager-entrypoint

RUN mkdir -p /data/processing /videos/unprocessed /videos/archived /videos/processed \
  && chmod +x /usr/local/bin/video-manager-entrypoint

EXPOSE 5333

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5333/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/video-manager-entrypoint"]
