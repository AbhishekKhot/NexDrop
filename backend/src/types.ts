// SYNC NOTE: Peer, Transfer, AgentMessage, BrowserMessage, and PROTOCOL_VERSION
// must stay in sync with frontend/src/types/index.ts — no shared package yet.

export interface Peer {
  id: string;
  name: string;
  ip?: string;
  port?: number;
  mode: "lan" | "remote";
  status: "available" | "busy" | "offline";
}

// hash (plaintext SHA-256) is separate from authTag: the tag proves the
// ciphertext wasn't modified in transit; the hash proves the decrypted bytes
// match what the sender intended. Both must pass.
export interface Chunk {
  transferId: string;
  index: number;
  total: number;
  data: Buffer;
  hash: string;
  iv: Buffer;
  authTag: Buffer;
}

export interface FileMetadata {
  transferId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  fileHash: string;
  senderPublicKey: string;
  chunkSize: number;
  protocolVersion: number;
}

// terminal states: completed | rejected | error
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

export type AgentMessage =
  | { type: "peers_update"; peers: Peer[] }
  | { type: "transfer_offer"; transfer: Transfer }
  | { type: "transfer_update"; transfer: Transfer }
  | {
      type: "agent_ready";
      deviceName: string;
      deviceId: string;
      maxFileSize: number;
    }
  | {
      type: "error";
      message: string;
      code?: string;
    };

// Binary frames (the actual file chunks, step 2 of streaming) are not listed
// here because they are raw ArrayBuffers, not JSON — the ws.on('message')
// handler checks isBinary to distinguish them.
export type BrowserMessage =
  | { type: "accept_transfer"; transferId: string }
  | { type: "reject_transfer"; transferId: string }
  | {
      type: "send_file_start";
      peerId: string;
      fileName: string;
      fileSize: number;
      totalChunks: number;
      chunkSize: number;
    }
  | { type: "send_file_end"; peerId: string; fileName: string }
  | { type: "discover_peers" };

// Bump when the binary framing or crypto handshake changes in a
// backwards-incompatible way.
export const PROTOCOL_VERSION = 2;

// Wire format for every frame:
//   [ 1 byte: frame type ] [ 4 bytes big-endian: payload length ] [ payload ]
// Control frames use JSON payloads. CHUNK frames use:
//   [ 12 bytes: AES-GCM IV ] [ 16 bytes: auth tag ] [ N bytes: ciphertext ]
export const TcpFrameType = {
  PUBLIC_KEY: 0x06,
  METADATA:   0x01,
  CHUNK:      0x02,
  DONE:       0x03,
  ACCEPT:     0x04,
  REJECT:     0x05,
} as const;

export type TcpControlFrame =
  | { kind: "PUBLIC_KEY"; publicKey: string }
  | { kind: "METADATA"; payload: FileMetadata }
  | { kind: "ACCEPT"; transferId: string }
  | { kind: "REJECT"; transferId: string }
  | { kind: "DONE"; transferId: string; fileHash: string };
