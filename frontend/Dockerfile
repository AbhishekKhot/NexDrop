# ============================================================
#  NexDrop Frontend — Dockerfile
#  Multi-stage: Vite build → nginx static server
#
#  VITE_* vars are baked in at BUILD time (not runtime).
#  Pass them as build-args via docker-compose or --build-arg.
# ============================================================

# ── Stage 1: Build ────────────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

# Build-time arguments — docker-compose passes these from root .env
ARG VITE_AGENT_WS_URL=ws://localhost:4001
ARG VITE_SIGNALING_URL=ws://localhost:4002
ARG VITE_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
ARG VITE_TURN_SERVER_URL=
ARG VITE_TURN_USERNAME=
ARG VITE_TURN_CREDENTIAL=

# Expose as ENV so Vite's import.meta.env picks them up at build time
ENV VITE_AGENT_WS_URL=$VITE_AGENT_WS_URL \
    VITE_SIGNALING_URL=$VITE_SIGNALING_URL \
    VITE_STUN_SERVERS=$VITE_STUN_SERVERS \
    VITE_TURN_SERVER_URL=$VITE_TURN_SERVER_URL \
    VITE_TURN_USERNAME=$VITE_TURN_USERNAME \
    VITE_TURN_CREDENTIAL=$VITE_TURN_CREDENTIAL

COPY package*.json ./
RUN npm ci

COPY . .

# Skip any local .env files — values come from build args above
RUN npm run build

# ── Stage 2: Serve with nginx ─────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
