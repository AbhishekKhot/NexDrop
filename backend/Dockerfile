# ============================================================
#  NexDrop Relay — Dockerfile
#  Multi-stage: build TypeScript → lean production image
#  Mirrors deploy/Dockerfile.relay; this one is wired into
#  the repo-root docker-compose.yml. Keep them in sync.
# ============================================================

# ── Stage 1: Build ────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production runner ────────────────────────────────────────
FROM node:20-alpine AS runner

# Non-root user (defense-in-depth even though the container is sandboxed)
RUN addgroup -S nexdrop && adduser -S nexdrop -G nexdrop

WORKDIR /app

ENV NODE_ENV=production
# In a container the relay must bind all interfaces; the host exposes only
# loopback by default in docker-compose.yml (or sits behind a proxy in prod).
ENV RELAY_BIND_HOST=0.0.0.0

# Install only production dependencies (drops jest, ts-node, nodemon, etc.)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

USER nexdrop

EXPOSE 4002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.RELAY_PORT||'4002')+'/', r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/relay.js"]
