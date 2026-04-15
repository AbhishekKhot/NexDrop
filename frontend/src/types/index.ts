/**
 * types/index.ts
 * Frontend type definitions that mirror the backend's types.ts.
 *
 * These types describe the data exchanged over the browser↔agent WebSocket.
 * They must stay in sync with backend/src/types.ts — any change to the wire
 * protocol (new fields, renamed states, etc.) requires updating both files.
 *
 * A future improvement would extract these into a shared package (e.g. packages/shared)
 * so the TypeScript compiler enforces consistency automatically.
 */

/**
 * A discovered peer that the local user can send files to.
 *
 * LAN peers  — found via mDNS; have ip + port for direct TCP transfer.
 * Remote peers — connected via WebRTC; ip/port are absent (routing is
 *               handled transparently by the DataChannel / STUN / TURN).
 */
export interface Peer {
  id: string;
  name: string;
  ip?: string;    // present for LAN peers; absent for WebRTC remote peers
  port?: number;  // TCP receive port; absent for WebRTC remote peers
  mode: "lan" | "remote";
  status: "available" | "busy" | "offline";
}

/**
 * States a transfer moves through over its lifecycle:
 *
 *  pending      → offer received; waiting for user to accept or reject
 *  accepted     → user clicked Accept; transfer is about to start
 *  transferring → chunks are flowing; chunksReceived is incrementing
 *  completed    → all chunks verified; file saved / downloaded successfully
 *  rejected     → user declined, or the 60-second auto-timeout fired
 *  error        → something went wrong (network drop, decryption failure, etc.)
 *
 * The UI renders different styles and labels for each state.
 */
export type TransferState =
  | "pending"
  | "accepted"
  | "rejected"
  | "transferring"
  | "completed"
  | "error";

/**
 * Full transfer record kept in React state (useAgentSocket / useRemoteTransfer).
 *
 * The browser receives these as transfer_update / transfer_offer WebSocket messages
 * and stores them in a Map<id, Transfer>.  Components read from this map to
 * render the transfer list and progress bars.
 */
export interface Transfer {
  id: string;
  peerId: string;
  peerName: string;
  direction: "send" | "receive";
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunksReceived: number;  // progress counter; increases as chunks arrive
  state: TransferState;
  errorMessage?: string;   // set when state === 'error'
  startedAt?: number;      // unix ms
  completedAt?: number;    // unix ms — set when state reaches a terminal state
}

/**
 * Messages pushed from the agent to the browser over WebSocket.
 *
 * agent_ready    — sent on connect; browser uses maxFileSize for client-side
 *                  file size validation (SEC-03) and displays the device name.
 * peers_update   — full snapshot of discovered LAN peers; browser replaces
 *                  its local peer list entirely.
 * transfer_offer — incoming file; browser shows the accept/reject modal.
 * transfer_update — state machine advance; browser updates the transfer list.
 * error           — unexpected condition; browser surfaces it as a toast.
 *                   code is a machine-readable identifier (e.g. 'MDNS_UNAVAILABLE').
 */
export type AgentMessage =
  | { type: "peers_update"; peers: Peer[] }
  | { type: "transfer_offer"; transfer: Transfer }
  | { type: "transfer_update"; transfer: Transfer }
  | {
      type: "agent_ready";
      deviceName: string;
      deviceId: string;
      /** Maximum file size the agent will accept — used for SEC-03 frontend validation */
      maxFileSize: number;
    }
  | {
      type: "error";
      message: string;
      /** Machine-readable code for programmatic handling in the frontend */
      code?: string;
    };

/**
 * Messages the browser sends to the agent over WebSocket.
 *
 * accept_transfer / reject_transfer — user decision on incoming offer modal.
 * send_file_start — precedes binary chunk frames; gives agent metadata to
 *                   create the InboundStream record.
 * send_file_end   — follows the last binary chunk; agent assembles and sends.
 * discover_peers  — triggers an immediate mDNS snapshot broadcast.
 *
 * Binary file chunks (the actual bytes) are sent as raw ArrayBuffer frames
 * between send_file_start and send_file_end — they are not represented here
 * because they are not JSON messages.
 */
export type BrowserMessage =
  | { type: "accept_transfer"; transferId: string }
  | { type: "reject_transfer"; transferId: string }
  | {
      type: "send_file_start";
      peerId: string;
      fileName: string;
      fileSize: number;
      totalChunks: number;
      chunkSize: number; // QUAL-04: lets agent validate slice size
    }
  | { type: "send_file_end"; peerId: string; fileName: string }
  | { type: "discover_peers" };
