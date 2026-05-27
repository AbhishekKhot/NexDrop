# NexDrop — Frontend

React 19 + Vite + TypeScript web UI for NexDrop's LAN (direct peer-to-peer) and Remote (relayed, end-to-end encrypted) file transfer.

- **LAN mode** talks to a local NexDrop agent over WebSocket (`ws://localhost:4001`).
- **Remote mode** talks to a WebSocket **relay** (`ws://localhost:4002` in dev, `wss://…` in prod), which pairs two browsers by share code and forwards end-to-end-encrypted file chunks. See [../docs/RELAY_PROTOCOL.md](../docs/RELAY_PROTOCOL.md).

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Project Layout](#project-layout)
- [Pages](#pages)
- [Hooks](#hooks)
- [Core Libraries](#core-libraries)
- [Remote Transfer Protocol (Browser Side)](#remote-transfer-protocol-browser-side)
- [Running Tests](#running-tests)
- [Build for Production](#build-for-production)

---

## Prerequisites

- Node.js 18 or higher, npm 9+
- For LAN mode: a running NexDrop agent (see [../backend/README.md](../backend/README.md))
- For Remote mode: a running relay (`npm run relay:dev` in `backend/`, or a deployed relay)

---

## Local Setup

```bash
cd frontend
npm install
cp .env.example .env      # optional for local dev
npm run dev               # Vite dev server on http://localhost:5173
```

---

## Environment Variables

All frontend env vars are prefixed with `VITE_` and embedded **at build time**.
Set them in `.env` (gitignored) or `.env.local`, and restart the dev server /
rebuild after changing them.

| Variable | Default | Description |
|---|---|---|
| `VITE_AGENT_WS_URL` | `ws://localhost:4001` | Local NexDrop agent (LAN mode) |
| `VITE_RELAY_URL` | `ws://localhost:4002` | Remote-mode relay (`wss://relay.example.com` in prod) |

Production example:

```env
VITE_AGENT_WS_URL=ws://localhost:4001
VITE_RELAY_URL=wss://relay.example.com
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
│   └── Remote.tsx              Remote share-code + relay file send UI
├── components/
│   ├── DeviceCard.tsx          Peer tile (name, select/deselect)
│   ├── IncomingTransferModal.tsx  Accept/Reject overlay for incoming files
│   └── ProgressBar.tsx         Animated transfer progress bar
├── hooks/
│   ├── useAgentSocket.ts       LAN: manages agent WS, peer list, send
│   └── useRemoteTransfer.ts    Remote: relay WS, ECDH, send/receive streaming
└── lib/
    ├── agentSocket.ts          Singleton agent WebSocket client (LAN)
    ├── remoteCrypto.ts         Web Crypto: ECDH P-256, AES-256-GCM, HKDF
    ├── remoteStatus.ts         Relay/peer status store for the header indicator
    ├── toast.tsx               Toast notifications
    └── utils.ts                formatBytes, formatState, formatSpeed, formatETA
```

---

## Pages

### Home (`/`)

Mode selection — **LAN** (same network) or **Remote** (any network). Routes to `/lan` or `/remote`.

### LAN (`/lan`)

Discovered peers as `DeviceCard` tiles (mDNS), drag-and-drop send via the local agent, transfer history, incoming-transfer modal.

### Remote (`/remote`)

Auto-creates a relay room on mount and shows a 10-char share code. The other side pastes the code and connects. Once paired (and ECDH completes), drag-and-drop send works; received files stream to disk (File System Access API) or download as a Blob.

---

## Hooks

### `useAgentSocket` (LAN)

Manages the singleton `AgentSocket` connection to the local agent. Reads the file, sends `send_file_start`, slices into 256 KB binary chunks (4-byte big-endian index prefix), then `send_file_end`.

### `useRemoteTransfer` (Remote)

Manages the relay WebSocket, ECDH key exchange, and chunked streaming. Returns:

```ts
{
  shareCode: string | null,
  remotePeer: Peer | null,
  transfers: Map<string, Transfer>,
  incomingTransfer: Transfer | null,
  lastError: string | null,
  createRoom: () => void,
  joinRoom: (code: string) => void,
  sendRemoteFile: (file: File) => void,
  acceptRemoteTransfer: (transferId: string) => void,
  rejectRemoteTransfer: (transferId: string) => void,
  dismissIncoming: () => void,
  disconnect: () => void,
}
```

---

## Core Libraries

### `agentSocket.ts`

Singleton WebSocket client for the LAN agent: auto-reconnect, binary frame decode (4-byte big-endian index + raw bytes), outbound backpressure on `bufferedAmount`.

### `remoteCrypto.ts`

Browser crypto via the **Web Crypto API**, shared by the Remote path:

| Function | Description |
|---|---|
| `generateECDHKeyPair()` | Ephemeral ECDH P-256 key pair |
| `exportPublicKeyBase64(key)` | Serialise public key for the wire |
| `importPublicKeyBase64(b64)` | Deserialise peer's public key |
| `deriveSharedKey(priv, peerPub)` | ECDH → HKDF-SHA256 → AES-256-GCM `CryptoKey` |
| `encryptChunk(key, plaintext)` | AES-256-GCM, random 12-byte IV → `[IV][ciphertext+tag]` |
| `decryptChunk(key, encrypted)` | AES-256-GCM decrypt + implicit auth-tag check |

---

## Remote Transfer Protocol (Browser Side)

```
useRemoteTransfer
  │
  ├─ connect to VITE_RELAY_URL → hello/welcome
  ├─ createRoom() → share code   |   joinRoom(code)
  ├─ on pairing: ECDH handshake over the relay → shared AES-256-GCM key
  │
  ├─ sendRemoteFile(file):
  │    ├─ size-check vs peer's advertised capability
  │    ├─ offer_transfer {fileName, fileSize, totalChunks}
  │    ├─ on accept → transfer_begin
  │    ├─ loop: file.slice(1 MiB) → encryptChunk → ws.send([index][IV][ct])
  │    │         (pauses on bufferedAmount > 8 MiB)
  │    └─ transfer_end
  │
  └─ receive:
       ├─ on offer_transfer → IncomingTransferModal
       ├─ acceptRemoteTransfer (user gesture): open FSA writer or Blob buffer
       ├─ per chunk: verify index, decryptChunk, write to disk / push to Blob
       └─ on transfer_end: assert N chunks → finalise download
```

**Receiver capability ladder**: if `window.showSaveFilePicker` exists
(Chrome/Edge), the file streams straight to disk (up to the relay's 5 GiB cap);
otherwise it accumulates a `Blob` (capped at 2 GiB) and triggers a download.
The browser declares its capability to the relay so the sender can pre-check.

**Integrity**: per-chunk AES-GCM tag + monotonic 4-byte index + `totalChunks`
count. There is no full-file hash (it would require hashing the whole file in
memory; the per-chunk guarantees already cover tamper/loss/reorder).

---

## Running Tests

```bash
npm test       # vitest run
```

Vitest uses `happy-dom` with `src/test/setup.ts` (WebSocket + URL mocks).

---

## Build for Production

```bash
npm run build   # tsc -b && vite build → dist/
npm run preview # serve dist/ locally to verify
```

`dist/` is a static SPA. All endpoints are baked in from the `VITE_*` env vars at
build time, so rebuild after changing `VITE_RELAY_URL` / `VITE_AGENT_WS_URL`.
