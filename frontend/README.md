# NexDrop — Frontend

React 19 + Vite + TypeScript. Single-page SPA whose only job is to pair two
browsers through the WebSocket relay and transfer end-to-end-encrypted files
between them. No accounts, no logins, no uploads to the app's server.

---

## Local Setup

```bash
cd frontend
npm install
cp .env.example .env          
npm run dev                 
```
---

## Environment Variables

`VITE_*` vars are **baked in at build time** — restart the dev server / rebuild
after changing them.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_RELAY_URL` | `ws://localhost:4002` | Relay endpoint. `wss://relay.example.com` in production. |

---

## Source Layout

```
src/
├── App.tsx                     Router (single route → Remote), header status
├── main.tsx                    React entry point
├── types/index.ts              Peer, Transfer, TransferState (LAN message types commented)
├── pages/
│   └── Remote.tsx              Share-code pairing + send/receive UI
├── components/
│   ├── DeviceCard.tsx          Peer tile (single tile in Remote-only build)
│   ├── IncomingTransferModal.tsx  Accept/Reject overlay
│   └── ProgressBar.tsx
├── hooks/
│   └── useRemoteTransfer.ts    Relay WS, ECDH, chunked streaming send/receive
├── lib/
│   ├── remoteCrypto.ts         Web Crypto: ECDH P-256, AES-256-GCM, HKDF
│   ├── remoteStatus.ts         Plain module store + useSyncExternalStore
│   ├── toast.tsx               Toast notifications
│   └── utils.ts                formatBytes, formatSpeed, formatETA…
└── [LAN files — line-commented]
    ├── pages/Home.tsx          Former LAN/Remote mode picker
    ├── pages/Lan.tsx           LAN peer list + send UI
    ├── hooks/useAgentSocket.ts Local agent WebSocket
    └── lib/agentSocket.ts      Singleton agent WS client
```

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

**Receiver capability ladder:** if `window.showSaveFilePicker` exists
(Chrome/Edge), the file streams straight to disk (up to the relay's 5 GiB cap);
otherwise it accumulates a `Blob` (capped at 2 GiB) and triggers a download.
The browser declares its capability to the relay so the sender can pre-check.

**Integrity:** per-chunk AES-GCM tag + monotonic 4-byte index + `totalChunks`
count. There is no full-file hash (it would require hashing the whole file in
memory; the per-chunk guarantees already cover tamper/loss/reorder).

---

## Crypto primitives (`remoteCrypto.ts`)

Browser Web Crypto API, wire-compatible with the relay protocol spec:

| Function | Description |
|---|---|
| `generateECDHKeyPair()` | Ephemeral ECDH P-256 key pair |
| `exportPublicKeyBase64(key)` | Serialise public key for the wire |
| `importPublicKeyBase64(b64)` | Deserialise peer's public key |
| `deriveSharedKey(priv, peerPub)` | ECDH → HKDF-SHA256 → AES-256-GCM `CryptoKey` |
| `encryptChunk(key, plaintext)` | AES-256-GCM, random 12-byte IV → `[IV][ciphertext+tag]` |
| `decryptChunk(key, encrypted)` | AES-256-GCM decrypt + implicit auth-tag check |

---

## Tests / Build

```bash
npm test     
npm run build 
npm run preview
```
