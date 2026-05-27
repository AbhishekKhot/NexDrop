# NexDrop Remote Relay Protocol — v1

Status: **DRAFT — for review (Task 1)**. No code depends on this yet.

This document is the contract for NexDrop's rewritten Remote transfer mode. It
defines how two browsers exchange a file through a cloud-hosted WebSocket relay.
The **file contents** are end-to-end encrypted — the relay forwards opaque
ciphertext and never sees plaintext bytes or the encryption key. **File
metadata (name, size) travels in plaintext** and is visible to the relay; this
is a deliberate v1 trade-off for simplicity (see §12).

LAN mode is unaffected and is **not** described here — see the agent/TCP docs.

---

## 1. Goals & non-goals

**Goals**

- Move a file (up to 5 GB) from one browser to another across arbitrary
  networks, with no NAT/ICE negotiation.
- End-to-end encryption of **file contents**: ECDH P-256 → HKDF-SHA256 →
  AES-256-GCM. The relay forwards opaque ciphertext chunks. File name/size are
  plaintext metadata (relay-visible).
- Streaming, not store-and-forward: the relay holds no file, only OS socket
  buffers. Time-to-first-byte at the receiver in tens of ms.
- One transfer at a time per room. Symmetric: either paired peer may send.
- Deployable on a single small VM (Oracle Always-Free ARM Ampere).

**Non-goals (v1)**

- Multi-peer / swarm distribution.
- Resumable transfers (a dropped connection aborts the transfer).
- Server-side persistence or "park-and-pickup" UX.
- Relay-side authentication/accounts (the share code is the only capability).

---

## 2. Roles & architecture

```
Sender Browser ─── WSS ───► Relay (cloud) ─── WSS ───► Receiver Browser
        host or joiner          pairs 2 conns          joiner or host
   File contents E2EE: ECDH P-256 → HKDF-SHA256 → AES-256-GCM
   Relay sees: ciphertext chunks, byte counts, timing, file name, size, peer IPs.
   Relay never sees: file contents (plaintext bytes), encryption key.
```

- **Relay**: a WSS server with an in-memory room registry. Pairs exactly two
  connections per room, forwards peer-directed control frames verbatim, and
  pipes binary data frames opaquely with byte-counting + backpressure.
- **Host**: the peer that creates the room and receives the share code.
- **Joiner**: the peer that joins with the share code.
- **Sender / Receiver**: per-transfer roles. After pairing, either peer can be
  the sender for a given transfer. Host/joiner does not dictate sender/receiver.

---

## 3. Transport

- **Protocol**: WebSocket over TLS (`wss://`). TLS terminates at the reverse
  proxy (Caddy); the relay process itself listens on plain `ws://` bound to
  loopback. See Task 8 deploy doc.
- **Endpoint**: single path `…/relay`. Connection intent is determined by the
  first frame (`create` or `join`), not by the path.
- **Origin allow-list (CWE-352 / CSWSH)**: on WS upgrade the relay validates the
  `Origin` header against `RELAY_ALLOWED_ORIGIN` (comma-separated allow-list).
  Mismatch → reject the upgrade with HTTP 403, no WS established.
- **Subprotocol**: none. Versioning is via the `hello` frame `v` field
  (see §6.1); the relay rejects unknown majors with `error UNSUPPORTED_VERSION`.

---

## 4. Room lifecycle (relay state machine)

```
                 create
   (none) ─────────────────────► WAITING ───────────────────► PAIRED
                              one conn, has code   join(code)  two conns
                                   │                              │
                  idle TTL / close │                              │ either conn closes
                                   ▼                              ▼
                                CLOSED ◄──── absolute TTL ──── PAIRED
```

- **WAITING**: room exists, host connected, no joiner. Expires after
  `RELAY_ROOM_TTL_MS` (default 10 min) if no joiner arrives.
- **PAIRED**: both peers connected. Subject to `RELAY_ROOM_ABSOLUTE_TTL_MS`
  (default 30 min) hard cap regardless of activity — prevents a pair from
  holding a room open indefinitely as a covert channel (resource bound,
  CWE-770).
- A room holds **at most two** connections. A third `join` for a PAIRED room →
  `error ROOM_FULL`.
- When either peer disconnects, the relay sends `peer_left` to the survivor and
  transitions the room back toward CLOSED (the survivor may keep its socket to
  `create`/`join` again, but the current room is gone).

### 4.1 Share codes

- **10 characters**, Crockford Base32 alphabet (`0-9 A-Z` minus `I L O U` to
  avoid ambiguity). 10 × 5 = **50 bits** of entropy.
- Generated with a CSPRNG (`crypto.randomBytes`) — never `Math.random`
  (CWE-330). On the rare generated-code collision with an existing room, retry
  (bounded, e.g. 5 attempts) then `error INTERNAL`.
- **Lookup is a hashmap keyed by code.** Constant-time comparison is *not*
  applicable to a keyed map lookup and is not used here. Brute-force resistance
  comes from: 50-bit entropy + short room TTL + failed-join rate limiting
  (§5). This is deliberate — do not "harden" it into an O(rooms) linear
  constant-time scan.
- Codes are bearer capabilities: anyone holding a valid code joins the room.
  They are transient (live only for the room's lifetime) and are never logged
  (§12).

---

## 5. Rate limiting & resource bounds (fail closed)

All limits configurable via env (§13); all reject by closing or erroring, never
by silently degrading.

| Limit | Default | Mechanism |
|---|---|---|
| Connections per IP | 5 | Reject WS upgrade beyond cap (`RATE_LIMITED`) |
| Messages per second per connection | 20 (control frames only) | Token bucket; breach → close `RATE_LIMITED` |
| Failed joins per IP per window | 10 / 60 s | Brute-force defence on codes; breach → `RATE_LIMITED`, backoff |
| Max file size (global) | 5 GiB | Reject `transfer_begin` over cap; hard-abort if streamed bytes exceed declared size |
| Room idle TTL | 10 min | WAITING rooms only |
| Room absolute TTL | 30 min | PAIRED rooms |
| Max control-frame size | 16 KiB | Reject oversized text frames (`PROTOCOL_VIOLATION`) |

The per-second message limit applies to **control (text) frames only**. Binary
data frames are governed by the byte-count cap + backpressure, not the message
counter (a 5 GB transfer is thousands of frames legitimately).

Client IP is taken from the socket peer address, or from the proxy's
`X-Forwarded-For` **only when** `RELAY_TRUST_PROXY=true` (set true behind Caddy,
false otherwise — an untrusted XFF is an IP-spoofing vector for the rate
limiter).

---

## 6. Message taxonomy

Three categories:

1. **Relay-directed control** (text/JSON) — the relay parses and acts on these.
   Set: `hello`, `create`, `join`, `leave`, `transfer_begin`, `transfer_end`.
2. **Peer-relayed messages** (text/JSON) — the relay forwards verbatim to the
   paired peer without interpreting the contents. Set: `ecdh_hello`,
   `offer_transfer`, `transfer_decision`, and any future
   `x_*` extension. The relay only checks: room is PAIRED, frame ≤ 16 KiB,
   rate-limit ok.
3. **Binary data frames** — opaque ciphertext, forwarded to the paired peer,
   byte-counted against the active transfer. Never parsed (§8).

Every text frame is a JSON object with a `t` (type) string field. Unknown `t`
in category 1's namespace → `error PROTOCOL_VIOLATION`. Unknown `t` outside it
is treated as a peer-relayed message and forwarded (forward-compat).

### 6.1 Relay-directed control frames

**`hello`** (client → relay, first frame after connect)
```jsonc
{ "t": "hello", "v": 1 }
```
Relay replies `welcome` or `error UNSUPPORTED_VERSION`. `v` is the protocol
major. A client MUST send `hello` before any other frame.

**`welcome`** (relay → client)
```jsonc
{ "t": "welcome", "v": 1, "maxFileSize": 5368709120 }
```
`maxFileSize` is the relay's global cap so the client can pre-validate.

**`create`** (client → relay)
```jsonc
{ "t": "create", "maxFileSize": 5368709120 }
```
`maxFileSize`: the largest file *this* peer can receive (capability-decided
client-side — FSA present → relay cap; Blob fallback → 2 GiB). Forwarded to the
joiner in `joined.peerMaxFileSize` so a symmetric sender can pre-check.
Relay creates a room (state WAITING) and replies:
```jsonc
{ "t": "created", "code": "7G4QX2MK9A" }
```
A connection already in a room → `error ALREADY_IN_ROOM`.

**`join`** (client → relay)
```jsonc
{ "t": "join", "code": "7G4QX2MK9A", "maxFileSize": 2147483648 }
```
- `code`: validated against `^[0-9A-HJKMNP-TV-Z]{10}$` (Crockford, length-exact)
  before lookup. Malformed → counts as a failed join (rate-limited) and
  `error ROOM_NOT_FOUND` (generic; do not reveal "malformed vs missing").
- `maxFileSize`: the largest file *this* peer can receive, decided client-side
  by capability (FSA present → up to relay cap; Blob fallback → 2 GiB). The
  relay forwards this to the host in `peer_joined.peerMaxFileSize` so a
  symmetric sender can pre-check.

On success: relay transitions room → PAIRED, replies `joined` to joiner and
`peer_joined` to host.

**`leave`** (client → relay)
```jsonc
{ "t": "leave" }
```
Voluntarily exit the current room. Relay sends `peer_left` to the other peer.

**`transfer_begin`** (sender → relay) — arms the data path
```jsonc
{ "t": "transfer_begin", "transferId": "uuid", "fileSize": 1234567, "totalChunks": 1178 }
```
- Sent **after** the receiver accepted (see §7).
- Relay validates: room PAIRED, no transfer currently active, `fileSize` is an
  integer in `[1, RELAY_MAX_FILE_SIZE]` (the **global** cap). Fail →
  `error FILE_TOO_LARGE` or `PROTOCOL_VIOLATION`. The per-receiver cap (2 GiB
  Blob / 5 GiB FSA) is **advisory** and enforced client-side — the relay only
  guards the global resource bound.
- Relay resets its byte counter to 0, marks transfer active, forwards
  `transfer_begin` to the receiver verbatim.
- No file name here — name is sent encrypted in the peer-relayed
  `offer_transfer` (§6.2).

**`transfer_end`** (sender → relay) — completion signal
```jsonc
{ "t": "transfer_end", "transferId": "uuid" }
```
Relay clears the active-transfer state and byte counter, forwards to receiver.
The receiver treats this as "all chunks sent": it asserts it received exactly
`totalChunks` in order and finalises the download.

### 6.2 Peer-relayed messages (relay forwards verbatim)

**`ecdh_hello`** — public key exchange (both peers send once after pairing)
```jsonc
{ "t": "ecdh_hello", "publicKey": "<base64 SPKI of ECDH P-256 public key>" }
```

**`offer_transfer`** — sender proposes a file; metadata is **plaintext**
```jsonc
{ "t": "offer_transfer", "transferId": "uuid",
  "fileName": "report.pdf", "fileSize": 1234567, "totalChunks": 1178 }
```
The receiver uses this to render the accept modal. Per the v1 decision, file
name/size are plaintext and relay-visible. The relay still does not act on this
frame (it is peer-relayed); the authoritative size for the cap is the separate
relay-directed `transfer_begin`. The receiver MUST validate that
`offer_transfer.fileName` is a safe display string (strip control chars; never
use it as a filesystem path — the browser's save dialog handles naming).

**`transfer_decision`** — receiver accepts/rejects
```jsonc
{ "t": "transfer_decision", "transferId": "uuid", "accepted": true }
```

There is no separate `file_end`. The relay-directed `transfer_end` (§6.1),
forwarded to the receiver, is the completion signal. Integrity does not rely on
a full-file hash (see §9) — it would force hashing the entire file in memory on
both ends, which is infeasible at 5 GB (Web Crypto has no streaming digest).

### 6.3 Relay → client notifications

```jsonc
{ "t": "joined", "code": "7G4QX2MK9A", "peerMaxFileSize": 5368709120 } // to joiner (host's cap)
{ "t": "peer_joined", "peerMaxFileSize": 2147483648 }                  // to host (joiner's cap)
{ "t": "peer_left" }                                                   // to survivor
{ "t": "error", "code": "ROOM_NOT_FOUND" }                             // see §14
```

---

## 7. Full transfer sequence (happy path)

```
Host (H)                 Relay (R)                 Joiner (J)
  │── hello ──────────────►│                            │
  │◄── welcome ────────────│                            │
  │── create ─────────────►│                            │
  │◄── created{code} ──────│                            │
  │   (share code OOB)     │◄──────────── hello ────────│
  │                        │──────────── welcome ──────►│
  │                        │◄── join{code,maxFileSize} ─│
  │◄ peer_joined{peerMax} ─│── joined{code} ───────────►│
  │                        │                            │
  │── ecdh_hello ─────────►│──────── ecdh_hello ───────►│   ECDH both ways
  │◄────── ecdh_hello ─────│◄──────── ecdh_hello ───────│   → shared AES key
  │                        │                            │
  │  (H decides to send)   │                            │
  │── offer_transfer ─────►│── offer_transfer ─────────►│   encrypted meta
  │                        │              (J shows modal)│
  │◄── transfer_decision ──│◄── transfer_decision{true}─│
  │── transfer_begin ─────►│ (arm cap+counter)           │
  │                        │── transfer_begin ─────────►│
  │== binary chunk 0 ═════►│== chunk 0 ════════════════►│   loop, backpressure
  │== binary chunk 1 ═════►│== chunk 1 ════════════════►│
  │        …               │         …                  │
  │── transfer_end ───────►│ (disarm)                    │
  │                        │── transfer_end ───────────►│   J asserts N chunks
  │                        │      (in-order) and         │
  │                        │      finalises download     │
```

Either peer may be the sender; the diagram shows the host sending, but the
joiner sending is symmetric.

---

## 8. Binary data frame format

A binary WebSocket frame carries exactly one encrypted chunk:

```
┌────────────────┬───────────────┬──────────────────────────────────────┐
│ chunk index    │ IV            │ AES-256-GCM ciphertext (incl. 16B tag) │
│ 4 bytes, BE u32│ 12 bytes      │ variable (≤ RELAY_CHUNK_SIZE + 16)     │
└────────────────┴───────────────┴──────────────────────────────────────┘
```

- **The relay does not parse this.** It forwards the frame and adds its byte
  length to the active-transfer counter.
- **Index**: big-endian uint32, 0-based. Load-bearing for integrity: the
  receiver asserts `index === expectedNext` on every chunk and that it received
  exactly `totalChunks` before finalising. Together with the per-chunk GCM tag
  this detects any missing, duplicated, reordered, or tampered chunk — which is
  why no full-file hash is needed.
- **IV**: 12 random bytes, unique per chunk (CSPRNG). With a per-transfer
  ECDH-derived key and ≤ ~5120 chunks (5 GiB / 1 MiB), we are far under the
  AES-GCM safe message-per-key bound; random 96-bit IVs are safe here
  (CWE-329 satisfied).
- **Plaintext chunk size**: `RELAY_CHUNK_SIZE` = **1 MiB** (independent of LAN
  mode's 256 KiB — these code paths are separate). Last chunk may be smaller.
- A binary frame received by the relay while **no transfer is active** →
  `error PROTOCOL_VIOLATION` + close (anti-abuse).

---

## 9. Cryptography (end-to-end)

Implemented in `frontend/src/lib/remoteCrypto.ts` (Web Crypto), matching the
backend's `crypto/aesGcm.ts` primitives used by LAN mode.

1. On pairing, each peer generates an **ephemeral** ECDH P-256 key pair
   (forward secrecy) and sends its public key via `ecdh_hello`.
2. Each derives the shared secret (ECDH) → **HKDF-SHA256** → 256-bit AES-GCM
   key. Key lives only in memory for the pairing; discarded on disconnect.
3. Every chunk: fresh random 12-byte IV → **AES-256-GCM** → ciphertext+tag.
   GCM's tag is the per-chunk integrity check (AEAD; no separate MAC).
4. File name and size travel in **plaintext** (`offer_transfer`) —
   relay-visible by the v1 decision. Only the file **bytes** (chunks) are
   encrypted.
5. **Integrity = per-chunk AES-GCM tag + 4-byte index + `totalChunks` count.**
   The GCM tag authenticates each chunk's bytes; the monotonic index plus the
   final count detect any missing, duplicated, reordered, or injected chunk.
   No full-file SHA-256 is used (it would require hashing the whole file in
   memory; Web Crypto offers no streaming digest, and the per-chunk guarantees
   already cover the threat).

The relay performs **zero** cryptographic operations. It cannot read or modify
plaintext; tampering with ciphertext fails the GCM tag and aborts the transfer.

---

## 10. Size limits & receiver capability

Two independent caps, both enforced:

- **Global relay cap** `RELAY_MAX_FILE_SIZE` (default 5 GiB): enforced at
  `transfer_begin` and as a hard byte-count abort.
- **Per-receiver cap** declared in `join.maxFileSize`:
  - File System Access API available (Chrome/Edge desktop, Android Chrome) →
    streams to disk, cap = relay global (5 GiB).
  - FSA absent (Firefox/Safari) → accumulates a `Blob`, cap = **2 GiB**.
  The sender pre-checks the peer's advertised cap (`peer_joined`/`joined`
  `peerMaxFileSize`) before offering; the relay independently re-checks only the
  **global** cap at `transfer_begin`. Over-cap offers are rejected client-side
  with a clear message ("this receiver's browser can't accept files larger than
  2 GB — ask them to use Chrome/Edge").

Receiver destination: the browser's Downloads folder (FSA "Save As" default
location, or the standard `<a download>` target). NexDrop does not control the
exact path browser-side; the agent's `~/Downloads/NexDrop` applies to LAN mode
only.

---

## 11. Flow control / backpressure

Node's `ws` does not auto-apply backpressure, so the relay implements it:

- For each forwarded binary frame, check the **destination** socket's
  `bufferedAmount`. When it exceeds `RELAY_BACKPRESSURE_HIGH` (e.g. 8 MiB),
  pause the **source** socket (`socket.pause()` / stop reading). Resume when the
  destination drains below `RELAY_BACKPRESSURE_LOW` (e.g. 1 MiB).
- This makes a slow receiver throttle a fast sender end-to-end via TCP, so the
  relay never accumulates more than ~`HIGH` bytes per direction.
- Sender (browser) additionally watches its own `WebSocket.bufferedAmount` and
  pauses its file-stream reader above 8 MiB (mirrors the existing
  `agentSocket.ts` 1 MB pattern, scaled up for the relay leg).

---

## 12. Security model (threats → mitigations)

| Threat | CWE | Mitigation |
|---|---|---|
| Cross-site WS hijack | CWE-352 | `Origin` allow-list on upgrade |
| Brute-forcing share codes | CWE-307 | 50-bit CSPRNG codes + failed-join rate limit + short TTL |
| Weak code randomness | CWE-330 | `crypto.randomBytes` only |
| Resource exhaustion (bandwidth/mem) | CWE-770 | Global size cap, byte-count hard-abort, per-IP conn cap, msg-rate cap, room TTLs, backpressure |
| IP spoofing of rate limiter | CWE-348 | Trust `X-Forwarded-For` only when `RELAY_TRUST_PROXY=true` behind a known proxy |
| Ciphertext tampering | CWE-354 | AES-256-GCM AEAD per chunk + end-to-end SHA-256 |
| Nonce reuse | CWE-323/329 | Random 12-byte IV per chunk, ephemeral per-transfer key |
| Eavesdropping on file contents at relay | — | Chunks are E2EE; relay sees ciphertext bytes only. File contents never exposed |
| Info leak via errors | CWE-209 | Generic error codes (§14); details logged server-side, redacted |
| Sensitive data in logs | CWE-532 | Never log share codes or payloads; file names MAY be logged at debug only (already relay-visible), default off |
| Oversized control frame DoS | CWE-770 | 16 KiB control-frame cap |
| Protocol confusion / smuggling | CWE-20 | Strict `hello`-first handshake, schema validation, unknown relay-frame rejection |

**Metadata the relay observes** (document honestly in Security Model): that a
transfer occurred, when, its byte size, the **file name**, and the two peers'
IPs. It does **not** observe file contents (the plaintext bytes). If full
metadata privacy is later required, encrypt the `offer_transfer` fields (the v1
spec deliberately keeps them plaintext).

---

## 13. Configuration (new env vars)

Backend (`backend/src/config.ts`), all with safe defaults:

| Var | Default | Purpose |
|---|---|---|
| `RELAY_PORT` | `4002` | Relay WSS listen port (plain ws behind proxy) |
| `RELAY_ALLOWED_ORIGIN` | `http://localhost:5173` | Comma-separated Origin allow-list |
| `RELAY_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for client IP |
| `RELAY_MAX_CONN_PER_IP` | `5` | Connection cap per IP |
| `RELAY_MAX_MSG_PER_SEC` | `20` | Control-frame rate cap per connection |
| `RELAY_MAX_FAILED_JOINS` | `10` | Failed joins per IP per window |
| `RELAY_FAILED_JOIN_WINDOW_MS` | `60000` | Failed-join window |
| `RELAY_ROOM_TTL_MS` | `600000` | WAITING idle TTL (10 min) |
| `RELAY_ROOM_ABSOLUTE_TTL_MS` | `1800000` | PAIRED absolute TTL (30 min) |
| `RELAY_MAX_FILE_SIZE` | `5368709120` | Global cap (5 GiB) |
| `RELAY_MAX_CONTROL_FRAME` | `16384` | Max text-frame bytes |
| `RELAY_BACKPRESSURE_HIGH` | `8388608` | Pause source above this dest buffer |
| `RELAY_BACKPRESSURE_LOW` | `1048576` | Resume below this |

Frontend (`VITE_*`, build-time):

| Var | Default | Purpose |
|---|---|---|
| `VITE_RELAY_URL` | `ws://localhost:4002` | Relay WSS URL (`wss://…` in prod) |

`RELAY_CHUNK_SIZE` (1 MiB) is a shared constant in code, not an env var.

---

## 14. Error codes

Returned as `{ "t": "error", "code": "<CODE>" }`. Generic by design — no internal
detail leaks to clients (CWE-209). The relay may additionally `close()` the
socket with a matching WS close code.

| Code | Meaning |
|---|---|
| `UNSUPPORTED_VERSION` | `hello.v` major not supported |
| `ALREADY_IN_ROOM` | `create`/`join` while already in a room |
| `ROOM_NOT_FOUND` | Unknown or malformed code on `join` |
| `ROOM_FULL` | `join` for an already-paired room |
| `NO_PEER` | Peer-relayed/binary frame sent while not paired |
| `FILE_TOO_LARGE` | `transfer_begin.fileSize` exceeds a cap |
| `TRANSFER_ACTIVE` | `transfer_begin` while one is already active |
| `RATE_LIMITED` | Connection / message / failed-join cap hit |
| `PROTOCOL_VIOLATION` | Bad frame, oversize, binary w/o active transfer, etc. |
| `INTERNAL` | Unexpected server error (no detail) |

---

## 15. Resolved decisions (v1)

1. **Symmetric sender** — ✅ either paired peer may initiate a send.
2. **Chunk index field** — ✅ keep the 4-byte big-endian index (defensive,
   matches LAN framing).
3. **Metadata encryption** — ✅ **plaintext** file name / size / hash for v1
   (relay-visible). Only file contents are encrypted. Revisit if metadata
   privacy becomes a requirement.
4. **Backpressure watermarks** — ✅ start at 8 MiB high / 1 MiB low; tune in
   Task 10 with real throughput numbers.

Contract is frozen for v1. Tasks 2 (relay skeleton) and 5 (frontend hook)
proceed against it.
