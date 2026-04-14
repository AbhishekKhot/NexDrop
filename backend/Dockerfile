# ============================================================
#  NexDrop Backend Agent — Dockerfile
#  Multi-stage: build TypeScript → lean production image
# ============================================================

# ── Stage 1: Build ────────────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production runner ────────────────────────────────────────
FROM node:18-alpine AS runner

# Non-root user for security
RUN addgroup -S nexdrop && adduser -S nexdrop -G nexdrop

WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Create downloads directory (overridden by DOWNLOAD_DIR env var)
RUN mkdir -p /downloads/NexDrop && chown -R nexdrop:nexdrop /downloads/NexDrop

USER nexdrop

# TCP (LAN transfers) | WS API (browser bridge) | Signaling (WebRTC)
EXPOSE 4000 4001 4002

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('net').connect(parseInt(process.env.WS_API_PORT||'4001'),'localhost',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
