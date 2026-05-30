# NexDrop — Backend (Relay)

Node.js + TypeScript. **One live entry point: the Remote relay**
— a standalone WebSocket server that pairs two browsers by share code and
forwards end-to-end-encrypted file chunks. The relay never sees plaintext.

---

## Local Setup

```bash
cd backend
npm install
cp .env.example .env         
npm run dev                  
```

Ready banner:

```
╔══════════════════════════════════════════════════╗
║            NexDrop Relay — Ready                  ║
╠══════════════════════════════════════════════════╣
║  Listen   : 127.0.0.1:4002                        ║
║  Max file : 5120 MiB                              ║
║  Origins  : http://localhost:5173                 ║
╚══════════════════════════════════════════════════╝
```

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run the relay with nodemon (auto-restart on change) |
| `npm run build` | `tsc` → `dist/relay.js` |
| `npm start` | `node dist/relay.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `jest` (20 tests for the relay) |

---

## Environment Variables

All relay settings come from environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `RELAY_PORT` | `4002` (or `PORT` if set) | TCP port to listen on. `PORT` fallback supports PaaS hosts (Render, Fly, Heroku). |
| `RELAY_BIND_HOST` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` inside containers or when no proxy fronts the relay. |
| `RELAY_ALLOWED_ORIGIN` | `http://localhost:5173` | **REQUIRED in production.** Comma-separated allow-list of WS-upgrade `Origin` headers (CWE-352 / CSWSH). |
| `RELAY_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for client IP. Set `true` **only** behind a known proxy (CWE-348). |
| `RELAY_MAX_FILE_SIZE` | `5368709120` (5 GiB) | Per-transfer byte cap; lying/oversize transfers are hard-aborted (CWE-770). |
| `RELAY_MAX_CONN_PER_IP` | `5` | Concurrent connections from one IP. |
| `RELAY_MAX_MSG_PER_SEC` | `20` | Per-connection control-frame token-bucket refill rate. |
| `RELAY_MAX_FAILED_JOINS` | `10` | Per-IP failed `join` attempts before throttling. |
| `RELAY_FAILED_JOIN_WINDOW_MS` | `60000` | Sliding window for the failed-join counter. |
| `RELAY_ROOM_TTL_MS` | `600000` (10 min) | Idle WAITING-room expiry. |
| `RELAY_ROOM_ABSOLUTE_TTL_MS` | `1800000` (30 min) | Absolute room expiry — bounds covert-channel abuse. |
| `RELAY_MAX_CONTROL_FRAME` | `16384` (16 KiB) | Drop control frames larger than this. |
| `RELAY_BACKPRESSURE_HIGH` | `8388608` (8 MiB) | Pause source socket when destination buffer exceeds this. |
| `RELAY_BACKPRESSURE_LOW` | `1048576` (1 MiB) | Resume source socket when destination buffer drops below this. |

---

## Source Layout

```
src/
├── relay.ts                       Entry point: spins up RelayServer, banner, SIGINT/SIGTERM
├── config.ts                      All RELAY_* env vars (LAN constants commented at top)
├── transport/
│   ├── relayServer.ts             RelayServer class: rooms, pairing, forwarding, all caps
│   └── relayServer.test.ts        20 jest tests covering every protocol path
└── [LAN files — line-commented]
    ├── index.ts                   LAN agent entry (disabled)
    ├── api/wsApi.ts               Browser ↔ agent WS (disabled)
    ├── discovery/mdns.ts          mDNS peer discovery (disabled)
    ├── transport/tcpServer.ts     LAN TCP server (disabled)
    ├── transport/tcpClient.ts     LAN TCP client (disabled)
    ├── chunking/*.ts              LAN chunk assembler/disassembler (disabled)
    ├── crypto/aesGcm.ts           LAN AES-GCM helpers (disabled)
    └── types.ts                   LAN message types (disabled)
```

---

## Safety surfaces in `relayServer.ts`

| Surface | Defense |
|---|---|
| WS upgrade | Origin allow-list (CWE-352 CSWSH); rejects non-listed origins. |
| Per-IP | Connection cap; failed-join rate limit with generic `ROOM_NOT_FOUND` (CWE-307). |
| Per-connection | Control-frame token bucket (CWE-770). |
| Control frame size | 16 KiB cap (CWE-770). |
| Byte payload | 5 GiB cap with hard abort on overrun. |
| Room lifecycle | Idle + absolute TTLs; explicit cleanup with double-cleanup guard. |
| Backpressure | Source socket paused when destination buffer > 8 MiB (`ws` does not auto-throttle). |
| Share code | `crypto.randomBytes` → Crockford Base32, 10 chars, 50 bits entropy (CWE-330). |
| Error responses | Generic codes (`ROOM_NOT_FOUND`, `ROOM_FULL`, etc.) — no internals leaked (CWE-209). |
| Logging | Never logs share codes, file names (DEBUG only), or payload bytes (CWE-532). |

---

## Running Tests

```bash
npm test                                                # all
npx jest src/transport/relayServer.test.ts              # the relay suite
npx jest -t "ROOM_FULL"                                 # one test by name
```

