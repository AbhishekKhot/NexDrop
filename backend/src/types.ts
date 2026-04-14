/**
 * types.ts
 * Shared types for the backend agent.
 * Must stay in sync with frontend/src/types/index.ts (or extract to shared package later).
 */

// ─── Peer ────────────────────────────────────────────────────────────────────

export interface Peer {
  id: string;
  name: string;
  ip?: string;
  port?: number;
  mode: "lan" | "remote";
  status: "available" | "busy" | "offline";
}

// ─── Chunk ───────────────────────────────────────────────────────────────────

export interface Chunk {
  transferId: string;
  index: number; // 0-based
  total: number;
  data: Buffer; // encrypted payload
  hash: string; // SHA-256 hex of plaintext chunk (before encryption)
  iv: Buffer; // 12-byte AES-GCM IV
  authTag: Buffer; // 16-byte AES-GCM auth tag
}

// ─── File Metadata ────────────────────────────────────────────────────────────

export interface FileMetadata {
  transferId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  fileHash: string; // SHA-256 hex of full plaintext file
  senderPublicKey: string; // ECDH ephemeral public key (hex)
}

// ─── Transfer ────────────────────────────────────────────────────────────────

export type TransferState =
  | "pending"
  | "accepted"
  | "rejected"
  | "transferring"
  | "completed"
  | "error";

export interface Transfer {
  id: string;
  peerId: string;
  peerName: string;
  direction: "send" | "receive";
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunksReceived: number;
  state: TransferState;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
}

// ─── WebSocket API messages (agent ↔ browser) ────────────────────────────────

export type AgentMessage =
  | { type: "peers_update"; peers: Peer[] }
  | { type: "transfer_offer"; transfer: Transfer }
  | { type: "transfer_update"; transfer: Transfer }
  | { type: "agent_ready"; deviceName: string; deviceId: string }
  | { type: "error"; message: string };

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
    }
  /** Step 3: browser signals all binary chunks have been sent */
  | { type: "send_file_end"; peerId: string; fileName: string }
  | { type: "discover_peers" };
// Binary frames (step 2) arrive as Buffer — not a JSON message type

// ─── TCP protocol frames ──────────────────────────────────────────────────────

/** Discriminated union for all TCP wire messages */
export type TcpFrame =
  | { kind: "METADATA"; payload: FileMetadata }
  | {
      kind: "CHUNK";
      payload: {
        transferId: string;
        index: number;
        total: number;
        iv: string;
        data: string;
        hash: string;
        authTag: string;
      };
    }
  | { kind: "ACCEPT"; transferId: string }
  | { kind: "REJECT"; transferId: string }
  | { kind: "DONE"; transferId: string; fileHash: string };
