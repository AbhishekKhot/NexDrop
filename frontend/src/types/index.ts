// Types shared by the Remote (relay) path. LAN-specific message types
// (AgentMessage / BrowserMessage) are line-commented below — re-enable
// alongside the LAN agent. Peer/Transfer/TransferState are reused by Remote.

export interface Peer {
  id: string;
  name: string;
  ip?: string;
  port?: number;
  // "lan" is preserved in the union for type-stability of the disabled LAN
  // code paths. The live Remote path only ever produces { mode: "remote" }.
  mode: "lan" | "remote";
  status: "available" | "busy" | "offline";
}

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

// ─── LAN FEATURE — DISABLED ──────────────────────────────────────────────
// LAN agent ↔ browser WS protocol. Re-enable alongside backend/src/api/wsApi.ts.
//
// export type AgentMessage =
//   | { type: "peers_update"; peers: Peer[] }
//   | { type: "transfer_offer"; transfer: Transfer }
//   | { type: "transfer_update"; transfer: Transfer }
//   | {
//       type: "agent_ready";
//       deviceName: string;
//       deviceId: string;
//       maxFileSize: number;
//     }
//   | {
//       type: "error";
//       message: string;
//       code?: string;
//     };
//
// export type BrowserMessage =
//   | { type: "accept_transfer"; transferId: string }
//   | { type: "reject_transfer"; transferId: string }
//   | {
//       type: "send_file_start";
//       peerId: string;
//       fileName: string;
//       fileSize: number;
//       totalChunks: number;
//       chunkSize: number;
//     }
//   | { type: "send_file_end"; peerId: string; fileName: string }
//   | { type: "discover_peers" };
