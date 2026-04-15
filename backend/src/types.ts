/**
 * types.ts
 * Shared type definitions for the NexDrop backend agent.
 *
 * This file is the single source of truth for all data structures that cross
 * module boundaries — between TCP transport, WebSocket API, mDNS discovery,
 * and the signaling server.
 *
 * SYNC NOTE: The core types (Peer, Transfer, AgentMessage, BrowserMessage) must
 * stay in sync with frontend/src/types/index.ts.  A future improvement would
 * extract these into a shared package to enforce it at compile time.
 */

// ─── Peer ────────────────────────────────────────────────────────────────────

/**
 * A discovered peer device that can send or receive files.
 *
 * - LAN peers are found via mDNS and carry an IP + port for direct TCP transfer.
 * - Remote peers are connected via WebRTC and have no IP/port (the DataChannel
 *   handles routing transparently through STUN/TURN).
 */
export interface Peer {
  id: string;
  name: string;
  ip?: string;    // present for LAN peers; absent for remote WebRTC peers
  port?: number;  // TCP receive port; absent for remote peers
  mode: "lan" | "remote";
  status: "available" | "busy" | "offline";
}

// ─── Chunk ───────────────────────────────────────────────────────────────────

/**
 * A single encrypted 256 KB slice of a file, ready to be sent over the wire.
 *
 * Each chunk carries everything the receiver needs to independently verify and
 * decrypt it — IV, auth tag, and a plaintext hash computed before encryption.
 * This design means the assembler can process chunks in any order and still
 * detect tampering without relying on transport ordering guarantees.
 *
 * The hash field (SHA-256 of plaintext) is separate from AES-GCM's auth tag:
 *  - auth tag: proves the ciphertext wasn't modified in transit
 *  - hash: proves the decrypted bytes match what the sender intended
 * Both checks must pass for a chunk to be accepted.
 */
export interface Chunk {
  transferId: string;
  index: number;    // 0-based chunk position within the file
  total: number;    // total number of chunks for this file
  data: Buffer;     // encrypted payload (ciphertext only, no IV/tag)
  hash: string;     // SHA-256 hex of plaintext chunk, computed before encryption
  iv: Buffer;       // 12-byte random AES-GCM nonce — unique per chunk
  authTag: Buffer;  // 16-byte AES-GCM authentication tag
}

// ─── File Metadata ────────────────────────────────────────────────────────────

/**
 * Metadata sent from the sender to the receiver before chunk streaming begins.
 *
 * Sent as a JSON-encoded METADATA frame in the TCP binary protocol.
 * The receiver uses this to:
 *  1. Display the incoming transfer modal with file name / size.
 *  2. Derive the shared AES session key from senderPublicKey.
 *  3. Validate the assembled file against fileHash at the end.
 *  4. Detect protocol version mismatches (protocolVersion).
 *
 * chunkSize is included (QUAL-04) so the receiver knows the expected slice
 * boundaries — important if the sender's config differs from the default.
 */
export interface FileMetadata {
  transferId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  fileHash: string;           // SHA-256 hex of the full plaintext file
  senderPublicKey: string;    // ECDH ephemeral public key (hex-encoded)
  chunkSize: number;          // bytes per chunk used by sender — QUAL-04
  protocolVersion: number;    // wire protocol version — CPU-02
}

// ─── Transfer ────────────────────────────────────────────────────────────────

/**
 * States a transfer progresses through, in order:
 *
 *  pending      → user has been notified, waiting for accept/reject
 *  accepted     → user clicked Accept; sender is about to stream chunks
 *  transferring → chunks arriving; chunksReceived is incrementing
 *  completed    → all chunks verified and file saved to disk
 *  rejected     → user clicked Reject, or 60-second timeout fired
 *  error        → unexpected failure (network, decryption, disk write, etc.)
 *
 * terminal states: completed | rejected | error
 */
export type TransferState =
  | "pending"
  | "accepted"
  | "rejected"
  | "transferring"
  | "completed"
  | "error";

/**
 * Runtime record for a single in-progress or completed file transfer.
 * Sent over WebSocket to the browser for UI updates via transfer_update messages.
 */
export interface Transfer {
  id: string;
  peerId: string;
  peerName: string;
  direction: "send" | "receive";
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunksReceived: number;  // increases as CHUNK frames arrive
  state: TransferState;
  errorMessage?: string;   // present only when state === 'error'
  startedAt?: number;      // unix ms — set when transfer is created
  completedAt?: number;    // unix ms — set when state reaches a terminal state
}

// ─── WebSocket API messages (agent ↔ browser) ────────────────────────────────

/**
 * Messages the agent pushes to the browser over WebSocket.
 *
 * agent_ready   — sent once on connect; browser uses maxFileSize for SEC-03 checks.
 * peers_update  — full peer list snapshot; browser replaces its local copy.
 * transfer_offer — incoming transfer found; browser shows the accept/reject modal.
 * transfer_update — state machine advance; browser updates the transfer list.
 * error         — unexpected condition; browser surfaces it as a toast notification.
 *                  code is machine-readable (e.g. 'MDNS_UNAVAILABLE', 'STREAM_TIMEOUT').
 */
export type AgentMessage =
  | { type: "peers_update"; peers: Peer[] }
  | { type: "transfer_offer"; transfer: Transfer }
  | { type: "transfer_update"; transfer: Transfer }
  | {
      type: "agent_ready";
      deviceName: string;
      deviceId: string;
      /** Maximum file size the agent will accept (bytes) — SEC-01/02/03 */
      maxFileSize: number;
    }
  | {
      type: "error";
      message: string;
      /** Optional machine-readable error code — ERR-01 */
      code?: string;
    };

/**
 * Messages the browser sends to the agent over WebSocket.
 *
 * accept_transfer / reject_transfer — user decision for an incoming offer.
 * send_file_start — announces that binary file chunks are about to follow.
 * send_file_end   — signals the stream is complete; agent assembles and sends.
 * discover_peers  — triggers an immediate mDNS peer list push.
 *
 * Binary frames (the actual file chunks, step 2 of streaming) are NOT listed
 * here because they are raw ArrayBuffers, not JSON — the ws.on('message') handler
 * checks isBinary to distinguish them.
 */
export type BrowserMessage =
  | { type: "accept_transfer"; transferId: string }
  | { type: "reject_transfer"; transferId: string }
  /** Step 1: browser announces intent to stream a file */
  | {
      type: "send_file_start";
      peerId: string;
      fileName: string;
      fileSize: number;
      totalChunks: number;
      chunkSize: number; // QUAL-04: lets agent log and validate slice boundaries
    }
  /** Step 3: browser signals all binary chunks have been sent */
  | { type: "send_file_end"; peerId: string; fileName: string }
  | { type: "discover_peers" };
// Binary frames (step 2) arrive as Buffer — not a JSON message type

// ─── TCP wire protocol ────────────────────────────────────────────────────────

/**
 * Wire protocol version — bump when the binary framing or crypto handshake
 * changes in a backwards-incompatible way (CPU-02).
 *
 * Included in the METADATA frame so the receiver can detect a version mismatch
 * and reject the connection with a clear error instead of silently corrupting
 * data by interpreting the new frame layout incorrectly.
 */
export const PROTOCOL_VERSION = 2;

/**
 * One-byte type identifiers for the binary length-prefix TCP framing (CPU-02).
 *
 * Wire format for every frame:
 *   [ 1 byte: frame type ] [ 4 bytes big-endian: payload length ] [ payload bytes ]
 *
 * Control frames (PUBLIC_KEY, METADATA, ACCEPT, REJECT, DONE) use JSON payloads.
 * CHUNK frames use a binary payload:
 *   [ 12 bytes: AES-GCM IV ] [ 16 bytes: auth tag ] [ N bytes: ciphertext ]
 *
 * Using a binary length-prefix instead of newline-delimited JSON+base64 (the
 * previous protocol) eliminates base64 encoding overhead (~33% per chunk) and
 * removes the need for JSON parsing on the hot path — meaningful for large files
 * where hundreds of CHUNK frames arrive per second.
 */
export const TcpFrameType = {
  PUBLIC_KEY: 0x06,  // ECDH ephemeral public key exchange
  METADATA:   0x01,  // FileMetadata JSON
  CHUNK:      0x02,  // encrypted binary chunk
  DONE:       0x03,  // transfer complete, includes full-file SHA-256
  ACCEPT:     0x04,  // receiver accepted the transfer
  REJECT:     0x05,  // receiver rejected the transfer
} as const;

/**
 * Discriminated union for all control frames (everything except CHUNK).
 *
 * Used by the TCP client's frame parser to get type-safe access to the JSON
 * payload without repeated casting.  CHUNK frames are handled separately
 * because their payload is binary, not JSON.
 */
export type TcpControlFrame =
  | { kind: "PUBLIC_KEY"; publicKey: string }
  | { kind: "METADATA"; payload: FileMetadata }
  | { kind: "ACCEPT"; transferId: string }
  | { kind: "REJECT"; transferId: string }
  | { kind: "DONE"; transferId: string; fileHash: string };
