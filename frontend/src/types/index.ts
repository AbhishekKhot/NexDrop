export interface Peer {
  id: string;
  name: string;
  ip?: string;
  port?: number;
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

export type AgentMessage =
  | { type: "peers_update"; peers: Peer[] }
  | { type: "transfer_offer"; transfer: Transfer }
  | { type: "transfer_update"; transfer: Transfer }
  | { type: "agent_ready"; deviceName: string; deviceId: string }
  | { type: "error"; message: string };

export type BrowserMessage =
  | { type: "accept_transfer"; transferId: string }
  | { type: "reject_transfer"; transferId: string }
  | {
      type: "send_file_start";
      peerId: string;
      fileName: string;
      fileSize: number;
      totalChunks: number;
    }
  | { type: "send_file_end"; peerId: string; fileName: string }
  | { type: "discover_peers" };
