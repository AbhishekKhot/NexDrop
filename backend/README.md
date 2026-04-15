# NexDrop — Backend Agent

Node.js + TypeScript agent responsible for LAN peer discovery, encrypted TCP file transfer, and WebRTC signaling relay.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Port Reference](#port-reference)
- [Source Layout](#source-layout)
- [LAN Transfer Protocol](#lan-transfer-protocol)
  - [1. Startup](#1-startup)
  - [2. Peer Discovery](#2-peer-discovery)
  - [3. File Send Flow (Sender Side)](#3-file-send-flow-sender-side)
  - [4. File Receive Flow (Receiver Side)](#4-file-receive-flow-receiver-side)
  - [5. Accept / Reject Decision](#5-accept--reject-decision)
  - [6. Chunk Format](#6-chunk-format)
- [WebSocket API Messages](#websocket-api-messages)
- [Signaling Server](#signaling-server)
- [Using with ngrok / Tunnels](#using-with-ngrok--tunnels)
- [Running Tests](#running-tests)

---

## Prerequisites

- Node.js 18 or higher
- npm 9+

---

## Local Setup

```bash
# From the backend directory
cd backend

# Install dependencies
npm install

# Copy and edit environment variables (optional for local dev)
cp .env.example .env

# Start development server (nodemon + ts-node)
npm run dev
```

On startup, the console prints your device name, LAN IP, and the bound ports. The agent is ready when you see:

```
[NexDrop] Agent ready — device: MyMacBook, TCP: 4000, WS: 4001, Signaling: 4002
```

To compile and run production build:

```bash
npm run build   # tsc → dist/
node dist/index.js
```

---

## Environment Variables

Copy `.env.example` to `.env` and override any value you need. All variables have safe defaults for local development.

| Variable | Default | Description |
|---|---|---|
| `TCP_PORT` | `4000` | Port the TCP server listens on for incoming LAN transfers |
| `WS_API_PORT` | `4001` | Port the WebSocket API server binds to |
| `SIGNALING_PORT` | `4002` | Port the WebRTC signaling relay binds to |
| `DEVICE_NAME` | `os.hostname()` | Display name broadcast via mDNS |
| `DOWNLOAD_DIR` | `~/Downloads/NexDrop` | Directory where received files are written |
| `ALLOW_REMOTE_WS` | `false` | Set to `true` to accept non-localhost WS connections (ngrok, Caddy proxy) |
| `WS_ALLOWED_ORIGIN` | `http://localhost:5173` | `Origin` header allowed on WS upgrade (CORS) |
| `MAX_CHUNK_SIZE` | `262144` | Chunk size in bytes (must match frontend `CHUNK_SIZE`) |
| `SIGNALING_MAX_CONN_PER_IP` | `5` | Max simultaneous WebSocket connections per IP on signaling |
| `SIGNALING_MAX_MSG_PER_SEC` | `20` | Max signaling messages per second per connection |
| `SIGNALING_ROOM_TTL_MS` | `600000` | How long a room waits for a second peer before expiring (ms) |

---

## Port Reference

| Port | Protocol | Purpose |
|---|---|---|
| 4000 | TCP | Receive encrypted LAN file transfers |
| 4001 | WebSocket | Browser ↔ agent API bridge |
| 4002 | WebSocket | WebRTC signaling relay (SDP/ICE only) |

---

## Source Layout

```
src/
├── index.ts                 Entry point — wires all services together
├── config.ts                Centralized env-var config with defaults
├── types.ts                 Shared TypeScript types (Peer, Transfer, Chunk…)
├── api/
│   └── wsApi.ts             HTTP server + WebSocket upgrade handler
├── chunking/
│   ├── chunker.ts           Split a file Buffer into encrypted Chunk[]
│   └── assembler.ts         Verify + decrypt Chunk[] → file Buffer
├── crypto/
│   └── aesGcm.ts            ECDH P-256, AES-256-GCM, HKDF-SHA256 helpers
├── discovery/
│   └── mdns.ts              mDNS advertise + browse (bonjour-service)
└── transport/
    ├── tcpClient.ts         Open TCP connection to peer and stream file
    ├── tcpServer.ts         Accept TCP connections, manage transfer lifecycle
    └── signalingServer.ts   WebRTC signaling relay with rate limiting
```

---

## LAN Transfer Protocol

### 1. Startup

`index.ts` initialises four services in order:

1. `MdnsService` — advertises this device and browses for peers
2. `TcpServer` — listens on `TCP_PORT` for incoming file transfers
3. `WsApiServer` — accepts the browser's WebSocket connection
4. `SignalingServer` — relays WebRTC SDP/ICE for Remote mode

### 2. Peer Discovery

- The agent runs `bonjour.advertise({ type: "peerdrop", port: TCP_PORT })` on startup.
- `bonjour.find({ type: "peerdrop" })` fires `up`/`down` events as peers appear and disappear.
- On each change the agent broadcasts `{ type: "peers_update", peers: [...] }` to all connected browser clients.
- The browser can also request an immediate refresh via `{ type: "discover_peers" }`.

### 3. File Send Flow (Sender Side)

```
Browser                         Agent (WsApiServer)              Peer Agent (TcpServer)
   │                                   │                                 │
   │── WS JSON: send_file_start ───────►│                                 │
   │   { peerId, fileName,              │                                 │
   │     totalChunks, fileHash }        │                                 │
   │                                   │                                 │
   │── WS Binary: [4-byte idx][data] ──►│                                 │
   │   (repeat for every chunk)         │ buffer chunks in memory         │
   │                                   │                                 │
   │── WS JSON: send_file_end ─────────►│                                 │
   │   { peerId, fileName }             │                                 │
   │                                   │── TCP connect ─────────────────►│
   │                                   │── ECDH key exchange ────────────►│
   │                                   │── METADATA frame ───────────────►│
   │                                   │   { transferId, fileName,        │
   │                                   │     totalChunks, fileHash,       │
   │                                   │     senderPublicKey }            │
```

### 4. File Receive Flow (Receiver Side)

```
Peer Agent (TcpClient)          Agent (TcpServer)              Browser
       │                               │                           │
       │── TCP connect ───────────────►│                           │
       │                               │── send ECDH public key ──►│ (internal)
       │── METADATA frame ────────────►│                           │
       │                               │── WS: transfer_offer ────►│
       │                               │   (shows accept modal)    │
       │    ... 60 s decision window ..│                           │
       │                               │◄── WS: accept_transfer ───│
       │◄── ACCEPT frame ──────────────│                           │
       │                               │                           │
       │── CHUNK frames ──────────────►│ decrypt + verify          │
       │   (repeat)                    │── WS: transfer_update ───►│
       │── DONE frame ────────────────►│                           │
       │                               │ verify full-file SHA-256  │
       │                               │ write file to DOWNLOAD_DIR│
       │                               │── WS: transfer_update ───►│
       │                               │   (state: completed)      │
```

### 5. Accept / Reject Decision

- On `METADATA` the TCP server registers a promise in `PendingDecisionMap` keyed by `transferId`.
- The browser sends `{ type: "accept_transfer", transferId }` or `{ type: "reject_transfer", transferId }`.
- If neither arrives within 60 seconds, the transfer is auto-rejected and the socket is closed.

### 6. Chunk Format

Each chunk is sent as a newline-terminated JSON string over the TCP socket:

```jsonc
// Sender → Receiver
{ "type": "CHUNK",
  "index": 3,
  "iv": "<12-byte base64>",
  "authTag": "<16-byte base64>",
  "data": "<base64-encoded AES-256-GCM ciphertext>",
  "hash": "<SHA-256 hex of plaintext>" }

// Control frames
{ "type": "METADATA", "transferId": "...", "fileName": "...", "totalChunks": 42, "fileHash": "...", "senderPublicKey": "..." }
{ "type": "ACCEPT" }
{ "type": "REJECT" }
{ "type": "DONE" }
```

Encryption per chunk:
1. Generate random 12-byte IV
2. AES-256-GCM encrypt plaintext chunk → `{ ciphertext, authTag }`
3. Compute SHA-256 of **plaintext** for integrity double-check
4. Base64-encode ciphertext before embedding in JSON

---

## WebSocket API Messages

The browser connects to `ws://localhost:4001`. All messages are JSON except binary file chunk frames.

### Browser → Agent

| `type` | Payload fields | Description |
|---|---|---|
| `discover_peers` | — | Request immediate mDNS scan |
| `send_file_start` | `peerId, fileName, totalChunks, fileHash` | Begin streaming a file |
| _(binary frame)_ | `[4-byte big-endian chunk index][raw bytes]` | One 256 KB chunk |
| `send_file_end` | `peerId, fileName` | Mark stream complete |
| `accept_transfer` | `transferId` | Accept an incoming transfer |
| `reject_transfer` | `transferId` | Reject an incoming transfer |

### Agent → Browser

| `type` | Payload fields | Description |
|---|---|---|
| `agent_ready` | `deviceName, agentId` | Sent immediately on WS connect |
| `peers_update` | `peers: Peer[]` | Current mDNS peer list |
| `transfer_offer` | `transfer: Transfer` | Incoming file — triggers modal |
| `transfer_update` | `transfer: Transfer` | Progress or state change |

---

## Signaling Server

The signaling server (`src/transport/signalingServer.ts`) is a lightweight WebSocket relay on port `4002`.

- **Room lifecycle**: Browser A creates a room → gets an 8-char code → shares it → Browser B joins → server relays SDP/ICE between them → room closes when both peers disconnect.
- **Rate limits** (configurable via env):
  - Max 5 simultaneous connections per IP
  - Max 20 signaling messages per second per connection
  - Room expires after 10 minutes if only one peer has joined
- **The server never touches file bytes** — only SDP offers/answers and ICE candidates pass through.

---

## Using with ngrok / Tunnels

To accept a browser WebSocket connection from outside localhost (e.g., phone browser → desktop agent):

```bash
# 1. Start agent with remote WS allowed
ALLOW_REMOTE_WS=true npm run dev

# 2. Expose port 4001
ngrok http 4001

# 3. In the frontend env, set:
VITE_AGENT_WS_URL=wss://<ngrok-subdomain>.ngrok.io
```

Set `WS_ALLOWED_ORIGIN` to match the frontend origin to avoid CORS rejections.

---

## Running Tests

```bash
npm test
```

Current coverage is minimal (2 test files — signaling server smoke tests). Full unit tests for crypto and chunking are planned (see [ERRORS.md](../ERRORS.md)).
