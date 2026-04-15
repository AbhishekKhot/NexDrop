# NexDrop — Frontend

React 19 + Vite + TypeScript web UI for LAN and Remote peer-to-peer file transfer.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Project Layout](#project-layout)
- [Pages](#pages)
- [Key Components](#key-components)
- [Hooks](#hooks)
- [Core Libraries](#core-libraries)
- [File Transfer Protocol (Browser Side)](#file-transfer-protocol-browser-side)
  - [LAN Send](#lan-send)
  - [Remote Send](#remote-send)
- [Connecting to the Backend](#connecting-to-the-backend)
- [Running Tests](#running-tests)
- [Build for Production](#build-for-production)

---

## Prerequisites

- Node.js 18 or higher
- npm 9+
- A running NexDrop backend agent (see [backend/README.md](../backend/README.md))

---

## Local Setup

```bash
# From the frontend directory
cd frontend

# Install dependencies
npm install

# Copy and edit environment variables (optional for local dev)
cp .env.example .env

# Start Vite dev server
npm run dev
```

Open http://localhost:5173 in your browser.

> The backend agent must be running at `ws://localhost:4001` before you open the UI.
> Start it with `cd backend && npm run dev`.

---

## Environment Variables

All frontend env vars are prefixed with `VITE_` and embedded at build time. Set them in `.env` (gitignored) or `.env.local`.

| Variable | Default | Description |
|---|---|---|
| `VITE_AGENT_WS_URL` | `ws://localhost:4001` | WebSocket URL of the local NexDrop agent |
| `VITE_SIGNALING_URL` | `ws://localhost:4002` | WebSocket URL of the WebRTC signaling server |
| `VITE_STUN_SERVERS` | `stun:stun.l.google.com:19302` | Comma-separated STUN server URLs |
| `VITE_TURN_SERVER_URL` | _(empty)_ | TURN server URL (optional, for symmetric NAT) |
| `VITE_TURN_USERNAME` | _(empty)_ | TURN credentials |
| `VITE_TURN_CREDENTIAL` | _(empty)_ | TURN credentials |

For a production deployment behind Caddy:

```env
VITE_AGENT_WS_URL=wss://nexdrop.example.com/agent
VITE_SIGNALING_URL=wss://nexdrop.example.com/signaling
VITE_TURN_SERVER_URL=turn:turn.example.com:3478
VITE_TURN_USERNAME=nexdrop
VITE_TURN_CREDENTIAL=<secret>
```

---

## Project Layout

```
src/
├── App.tsx                     Router, global layout, IncomingTransferModal
├── main.tsx                    React entry point
├── types/
│   └── index.ts                Shared types: Peer, Transfer, TransferState…
├── pages/
│   ├── Home.tsx                Mode selection (LAN vs Remote)
│   ├── Lan.tsx                 LAN peer discovery + file send UI
│   └── Remote.tsx              Remote share-code + WebRTC file send UI
├── components/
│   ├── DeviceCard.tsx          Peer tile (name, IP, select/deselect)
│   ├── IncomingTransferModal.tsx  Accept/Reject overlay for incoming files
│   └── ProgressBar.tsx         Animated transfer progress bar
├── hooks/
│   ├── useAgentSocket.ts       LAN: manages WS connection, peer list, send
│   └── useRemoteTransfer.ts    Remote: manages WebRTC, ECDH, send/receive
└── lib/
    ├── agentSocket.ts          Singleton WebSocket client with auto-reconnect
    ├── remoteCrypto.ts         Web Crypto API: ECDH P-256, AES-256-GCM, HKDF
    ├── webrtc.ts               P2PConnection — RTCPeerConnection + DataChannel
    └── utils.ts                formatBytes, formatState helpers
```

---

## Pages

### Home (`/`)

Mode selection screen. User picks **LAN** (same network) or **Remote** (any network). Routes to `/lan` or `/remote`.

### LAN (`/lan`)

- Shows discovered peers as `DeviceCard` tiles, refreshed every 5 s via mDNS
- Drag-and-drop zone or file picker to select a file
- Send button streams the file to the selected peer via the local agent
- Transfer history list with live progress bars
- Incoming transfer modal pops up when another peer sends a file

### Remote (`/remote`)

- Auto-creates a signaling room on mount and shows an 8-char share code
- Peer can join by entering the code
- Once both peers are connected, file drag-and-drop send works identically to LAN
- Receive progress shown inline

---

## Key Components

### `DeviceCard`

Displays a single discovered peer. Props: `peer: Peer`, `selected: boolean`, `onSelect: () => void`. Shows device name derived from hostname with an emoji prefix, plus the IP:port.

### `IncomingTransferModal`

Full-screen overlay shown when `transfer_offer` arrives from the agent. Displays file name, size, chunk count. Buttons call `onAccept` / `onReject`. Auto-rejects after 60 s.

### `ProgressBar`

Simple progress bar driven by a `0–100` percentage prop. Used in the transfer history list and the receive panel.

---

## Hooks

### `useAgentSocket`

Manages the singleton `AgentSocket` connection to the local backend agent. Returns:

```ts
{
  connected: boolean,
  peers: Peer[],
  transfers: Map<string, Transfer>,
  incomingOffer: Transfer | null,
  acceptTransfer: (transferId: string) => void,
  rejectTransfer: (transferId: string) => void,
  sendFile: (peerId: string, file: File) => Promise<void>,
  discoverPeers: () => void,
}
```

Internally the hook:
1. Reads the file with `File.arrayBuffer()`
2. Sends `send_file_start` JSON frame
3. Slices the buffer into 256 KB chunks and sends each as a binary WebSocket frame prefixed with a 4-byte big-endian chunk index
4. Sends `send_file_end` JSON frame

### `useRemoteTransfer`

Manages WebRTC peer connection, ECDH key exchange, and DataChannel-based file streaming. Returns:

```ts
{
  shareCode: string,
  peerConnected: boolean,
  sendProgress: number,
  receiveProgress: number,
  incomingOffer: Transfer | null,
  joinRoom: (code: string) => void,
  sendFile: (file: File) => Promise<void>,
  acceptTransfer: () => void,
  rejectTransfer: () => void,
}
```

---

## Core Libraries

### `agentSocket.ts`

Singleton `AgentSocket` class wrapping a native `WebSocket`. Features:
- Auto-reconnects every 3 s on disconnect
- Binary frame decode: first 4 bytes = chunk index (big-endian uint32), remainder = raw chunk data
- Outbound backpressure: polls `bufferedAmount` and waits when > 1 MB

### `remoteCrypto.ts`

Browser-side crypto using the **Web Crypto API** (hardware-backed on modern browsers). Provides:

| Function | Description |
|---|---|
| `generateKeyPair()` | Generates ephemeral ECDH P-256 key pair |
| `exportPublicKey(key)` | Serialises public key to Base64 for DataChannel |
| `importPublicKey(b64)` | Deserialises peer's public key |
| `deriveSharedKey(privKey, peerPubKey)` | ECDH → HKDF-SHA256 → AES-256-GCM `CryptoKey` |
| `encryptChunk(key, plaintext)` | AES-256-GCM with random 12-byte IV → `{ iv, ciphertext, authTag }` |
| `decryptChunk(key, iv, ciphertext)` | AES-256-GCM decrypt + implicit auth tag check |
| `sha256(buffer)` | SHA-256 digest → hex string |

### `webrtc.ts`

`P2PConnection` class wrapping `RTCPeerConnection`:
- Creates `RTCDataChannel("file-transfer")` with `ordered: true`
- Implements `send(data)` with backpressure via `bufferedamountlow` event
- Exposes `onMessage`, `onStateChange` callbacks

---

## File Transfer Protocol (Browser Side)

### LAN Send

```
useAgentSocket.sendFile(peerId, file)
  │
  ├─ file.arrayBuffer()              — load whole file into memory
  ├─ WS JSON: send_file_start        — announce fileName, totalChunks, fileHash
  ├─ loop chunks:
  │    ├─ slice buffer (256 KB)
  │    └─ WS Binary: [4-byte index][chunk data]
  └─ WS JSON: send_file_end          — agent triggers TCP send to peer
```

### Remote Send

```
useRemoteTransfer.sendFile(file)
  │
  ├─ (DataChannel already open, ECDH key already exchanged)
  ├─ file.arrayBuffer()
  ├─ DataChannel JSON: send_file_start
  ├─ loop chunks:
  │    ├─ remoteCrypto.encryptChunk(sessionKey, chunk)
  │    └─ DataChannel Binary: { iv, ciphertext, authTag, hash }
  └─ DataChannel JSON: send_file_end
```

ECDH handshake (runs once on DataChannel open):
1. Both peers call `generateKeyPair()` and send `{ type: "ecdh_hello", publicKey }` over the DataChannel
2. On receiving the peer's `ecdh_hello`, call `deriveSharedKey()` to produce the session AES key
3. All subsequent chunk messages are encrypted with that key

---

## Connecting to the Backend

For local development no configuration is needed — the defaults point to `localhost`.

For a shared backend (e.g., running on another machine on the same LAN):

```env
# .env.local
VITE_AGENT_WS_URL=ws://192.168.1.10:4001
VITE_SIGNALING_URL=ws://192.168.1.10:4002
```

For a remote/cloud backend with TLS (Caddy):

```env
VITE_AGENT_WS_URL=wss://nexdrop.example.com/agent
VITE_SIGNALING_URL=wss://nexdrop.example.com/signaling
```

---

## Running Tests

```bash
npm test
```

The test suite currently has one file (`useRemoteTransfer.test.ts`) with basic smoke tests. Extended coverage is planned — see [ERRORS.md](../ERRORS.md).

---

## Build for Production

```bash
npm run build   # outputs to dist/
npm run preview # serves dist/ locally to verify
```

The `dist/` folder is a static SPA — serve with any web server (nginx, Caddy, Netlify, etc.). All API calls go to the backend via the `VITE_*` env vars baked in at build time.
