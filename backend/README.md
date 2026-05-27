# NexDrop — Backend

Node.js + TypeScript. Two independent entry points:

- **LAN agent** (`src/index.ts`, `npm run dev`) — mDNS peer discovery + encrypted TCP file transfer, bridged to the browser over a local WebSocket.
- **Remote relay** (`src/relay.ts`, `npm run relay:dev`) — a standalone WebSocket relay that pairs two browsers by share code and forwards end-to-end-encrypted file chunks. Deployed separately (see [../deploy/README.md](../deploy/README.md)); the relay wire protocol is specified in [../docs/RELAY_PROTOCOL.md](../docs/RELAY_PROTOCOL.md).

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Port Reference](#port-reference)
- [Source Layout](#source-layout)
- [LAN Transfer Protocol](#lan-transfer-protocol)
- [WebSocket API Messages (LAN)](#websocket-api-messages-lan)
- [Remote Relay](#remote-relay)
- [Running Tests](#running-tests)

---

## Prerequisites

- Node.js 18 or higher
- npm 9+

---

## Local Setup

```bash
cd backend
npm install
cp .env.example .env          # optional for local dev

# LAN agent (mDNS + TCP):
npm run dev                   # nodemon + ts-node

# Remote relay (separate process/terminal):
npm run relay:dev
```

LAN agent ready banner:

```
║              NexDrop Agent — Ready              ║
║  TCP receiver   :4000  (LAN file transfers)     ║
║  WS API         :4001  (browser UI bridge)      ║
```

Relay ready banner:

```
║            NexDrop Relay — Ready                ║
║  Listen   : 127.0.0.1:4002                      ║
```

Production builds:

```bash
npm run build        # tsc → dist/ (dist/index.js + dist/relay.js)
node dist/index.js   # LAN agent
node dist/relay.js   # Remote relay  (or: npm run relay)
```

---

## Environment Variables

Copy `.env.example` to `.env`. All values have safe local-dev defaults.

### LAN agent (`index.ts`)

| Variable | Default | Description |
|---|---|---|
| `TCP_PORT` | `4000` | TCP server port for incoming LAN transfers |
| `WS_API_PORT` | `4001` | WebSocket API port (browser ↔ agent) |
| `DEVICE_NAME` | `os.hostname()` | Display name broadcast via mDNS |
| `DOWNLOAD_DIR` | `~/Downloads/NexDrop` | Where received LAN files are written |
| `ALLOW_REMOTE_WS` | `false` | Accept non-localhost WS API connections (tunnels) |
| `WS_ALLOWED_ORIGIN` | `http://localhost:5173` | Allowed `Origin` on the WS API upgrade |
| `MAX_FILE_SIZE` | `2147483648` | LAN transfer size cap (bytes) |

### Remote relay (`relay.ts`)

| Variable | Default | Description |
|---|---|---|
| `RELAY_PORT` | `4002` | Relay WS listen port |
| `RELAY_BIND_HOST` | `127.0.0.1` | Bind address (loopback behind a proxy; `0.0.0.0` in a container) |
| `RELAY_ALLOWED_ORIGIN` | `http://localhost:5173` | Comma-separated Origin allow-list (CSWSH defence) |
| `RELAY_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for client IP (only behind a known proxy) |
| `RELAY_MAX_FILE_SIZE` | `5368709120` | Global transfer cap, 5 GiB (bytes) |
| `RELAY_MAX_CONN_PER_IP` | `5` | Max simultaneous connections per IP |
| `RELAY_MAX_MSG_PER_SEC` | `20` | Max control frames/sec per connection |
| `RELAY_MAX_FAILED_JOINS` | `10` | Failed joins per IP per window (brute-force defence) |
| `RELAY_FAILED_JOIN_WINDOW_MS` | `60000` | Failed-join window |
| `RELAY_ROOM_TTL_MS` | `600000` | Idle (one-peer) room TTL |
| `RELAY_ROOM_ABSOLUTE_TTL_MS` | `1800000` | Absolute room lifetime cap |

---

## Port Reference

| Port | Protocol | Process | Purpose |
|---|---|---|---|
| 4000 | TCP | LAN agent | Receive encrypted LAN file transfers |
| 4001 | WebSocket | LAN agent | Browser ↔ agent API bridge |
| 4002 | WebSocket | Remote relay | Pair browsers + forward E2EE chunks |

---

## Source Layout

```
src/
├── index.ts                 LAN agent entry — wires mDNS + TCP + WS API
├── relay.ts                 Remote relay entry — standalone, deployed separately
├── config.ts                Centralized env-var config with defaults
├── types.ts                 Shared types (Peer, Transfer, Chunk, TCP frames…)
├── api/
│   └── wsApi.ts             HTTP server + WS upgrade handler (LAN browser bridge)
├── chunking/
│   ├── chunker.ts           Split a file Buffer into encrypted Chunk[] (LAN)
│   └── assembler.ts         Verify + decrypt Chunk[] → file Buffer (LAN)
├── crypto/
│   └── aesGcm.ts            ECDH P-256, AES-256-GCM, HKDF-SHA256 helpers (LAN)
├── discovery/
│   └── mdns.ts              mDNS advertise + browse (bonjour-service)
└── transport/
    ├── tcpClient.ts         Open TCP connection to peer and stream file (LAN)
    ├── tcpServer.ts         Accept TCP connections, manage transfer lifecycle (LAN)
    ├── relayServer.ts       Remote relay: rooms, pairing, E2EE chunk forwarding
    └── relayServer.test.ts  Relay test suite
```

---

## LAN Transfer Protocol

### Startup

`index.ts` initialises three services in order:

1. `MdnsService` — advertises this device and browses for peers
2. `TcpServer` — listens on `TCP_PORT` for incoming file transfers
3. `WsApiServer` — accepts the browser's WebSocket connection

### Peer Discovery

- The agent runs `bonjour.advertise({ type: "peerdrop", port: TCP_PORT })` on startup.
- `bonjour.find({ type: "peerdrop" })` fires `up`/`down` events as peers appear and disappear.
- On each change the agent broadcasts `{ type: "peers_update", peers: [...] }` to all connected browser clients.

### File Send / Receive

The browser streams the file to its local agent over the WS API (`send_file_start`
→ binary chunks → `send_file_end`). The agent buffers the chunks, opens a TCP
connection to the peer, performs an ECDH key exchange, sends a `METADATA` frame,
and — once the receiver accepts — streams AES-256-GCM `CHUNK` frames followed by
`DONE`. The receiver decrypts, verifies per-chunk and full-file SHA-256, and
writes the file to `DOWNLOAD_DIR`. A 60-second decision window auto-rejects an
unanswered offer.

### Chunk Format (TCP)

Each frame is `[1-byte type][4-byte big-endian length][payload]`. Control frames
(`PUBLIC_KEY`, `METADATA`, `ACCEPT`, `REJECT`, `DONE`) carry JSON; `CHUNK` frames
carry `[12-byte IV][16-byte tag][ciphertext]`. Per chunk: random 12-byte IV →
AES-256-GCM → SHA-256 of the plaintext for a defense-in-depth integrity check.

---

## WebSocket API Messages (LAN)

The browser connects to `ws://localhost:4001`. All messages are JSON except binary file-chunk frames.

### Browser → Agent

| `type` | Payload fields | Description |
|---|---|---|
| `discover_peers` | — | Request immediate mDNS scan |
| `send_file_start` | `peerId, fileName, fileSize, totalChunks, chunkSize` | Begin streaming a file |
| _(binary frame)_ | `[4-byte big-endian chunk index][raw bytes]` | One 256 KB chunk |
| `send_file_end` | `peerId, fileName` | Mark stream complete |
| `accept_transfer` | `transferId` | Accept an incoming transfer |
| `reject_transfer` | `transferId` | Reject an incoming transfer |

### Agent → Browser

| `type` | Payload fields | Description |
|---|---|---|
| `agent_ready` | `deviceName, deviceId, maxFileSize` | Sent immediately on WS connect |
| `peers_update` | `peers: Peer[]` | Current mDNS peer list |
| `transfer_offer` | `transfer: Transfer` | Incoming file — triggers modal |
| `transfer_update` | `transfer: Transfer` | Progress or state change |
| `error` | `message, code?` | Surfaced as a toast in the UI |

---

## Remote Relay

The relay (`src/transport/relayServer.ts`, entry `src/relay.ts`) is a standalone
WebSocket server. It pairs exactly two browsers per room (10-char share code) and
forwards control frames and opaque encrypted binary chunks between them — it
performs **zero** cryptography and never sees plaintext.

Highlights (full detail in [../docs/RELAY_PROTOCOL.md](../docs/RELAY_PROTOCOL.md)):

- **Handshake**: `hello`/`welcome` → `create` (get code) / `join {code}` → `peer_joined`/`joined`.
- **ECDH** is exchanged peer-to-peer via the relay (`ecdh_hello`); the relay can't read it.
- **Transfer**: `offer_transfer` → `transfer_decision` → `transfer_begin` → binary chunks → `transfer_end`.
- **Binary frame**: `[4-byte index][12-byte IV][AES-256-GCM ciphertext]`, 1 MiB plaintext chunks.
- **Integrity**: per-chunk GCM tag + monotonic index + `totalChunks` count (no full-file hash needed).
- **Safety**: Origin allow-list, per-IP connection cap, per-connection control-frame rate limit, failed-join rate limit, 16 KiB control-frame cap, global 5 GiB byte cap with hard abort, idle + absolute room TTLs, explicit backpressure (pauses the source socket when the destination buffers > 8 MiB).

The relay holds no file — only OS socket buffers — and writes nothing to disk.

To run a relay in the cloud, see [../deploy/README.md](../deploy/README.md).

---

## Running Tests

```bash
npm test
```

The suite (`src/transport/relayServer.test.ts`) drives a live relay through a
`ws` client: handshake, room create/join/full/not-found, capability exchange,
peer-relay forwarding, oversize rejection, end-to-end binary round-trip, byte-cap
hard abort, peer-left on disconnect, and the per-IP / message-rate / failed-join /
room-TTL limits (via the `RelayServer` constructor's limits-override).
