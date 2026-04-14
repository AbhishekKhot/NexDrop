/**
 * index.ts — NexDrop local agent entrypoint.
 *
 * Services started:
 *  1. mDNS  — LAN peer discovery (advertise + browse)
 *  2. TCP server — receive incoming LAN file transfers
 *  3. WS API  — browser↔agent bridge (localhost:4001)
 *  4. Signaling server — WebRTC SDP/ICE relay (port 4002)
 */

import os from "os";
import { MdnsService } from "./discovery/mdns";
import { createTcpServer, PendingDecisionMap } from "./transport/tcpServer";
import { sendFileToPeer } from "./transport/tcpClient";
import { createSignalingServer } from "./transport/signalingServer";
import { WsApiServer } from "./api/wsApi";
import { TCP_PORT, WS_API_PORT, SIGNALING_PORT, DEVICE_NAME } from "./config";
import type { Peer, Transfer } from "./types";

// ─── State ────────────────────────────────────────────────────────────────────

const peers: Map<string, Peer> = new Map();
const pendingDecisions = new PendingDecisionMap();

// ─── mDNS ─────────────────────────────────────────────────────────────────────

const mdns = new MdnsService((updatedPeers) => {
  // Keep global peer map in sync
  peers.clear();
  updatedPeers.forEach((p) => peers.set(p.id, p));
  // Broadcast to browser
  wsApi.broadcast({ type: "peers_update", peers: updatedPeers });
});

mdns.advertise();
mdns.browse();

// ─── WS API (browser ↔ agent) ─────────────────────────────────────────────────

const wsApi = new WsApiServer(mdns.deviceId);

/** Re-send current peer list when browser requests discovery */
wsApi.onDiscoverPeers = () => {
  wsApi.broadcast({ type: "peers_update", peers: mdns.getPeers() });
};

/**
 * Browser has streamed a full file → send it to the LAN peer via TCP.
 * The WsApiServer has already assembled the binary chunks into a Buffer.
 */
wsApi.onSendFile = async (
  peerId: string,
  fileName: string,
  fileBuffer: Buffer,
) => {
  const peer = peers.get(peerId);
  if (!peer) {
    wsApi.broadcast({
      type: "error",
      message: `Peer ${peerId} not found in peer list`,
    });
    return;
  }
  if (!peer.ip || !peer.port) {
    wsApi.broadcast({
      type: "error",
      message: `Peer ${peer.name} has no IP/port — not yet discovered via mDNS`,
    });
    return;
  }

  console.log(
    `[Agent] Sending "${fileName}" (${fileBuffer.length} bytes) to ${peer.name} @ ${peer.ip}:${peer.port}`,
  );

  try {
    await sendFileToPeer(
      peer.ip,
      peer.port,
      peer.id,
      peer.name,
      fileBuffer,
      fileName,
      (transfer: Transfer) => {
        wsApi.broadcast({ type: "transfer_update", transfer });
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Send failed:`, message);
    wsApi.broadcast({ type: "error", message: `Send failed: ${message}` });
  }
};

wsApi.onAcceptTransfer = (transferId) => {
  pendingDecisions.respond(transferId, true);
};

wsApi.onRejectTransfer = (transferId) => {
  pendingDecisions.respond(transferId, false);
};

// ─── TCP Server (receive LAN files) ───────────────────────────────────────────

createTcpServer(
  pendingDecisions,
  // onOffer: receiver sees an incoming transfer — show modal in browser
  (transfer) => {
    wsApi.broadcast({ type: "transfer_offer", transfer });
  },
  // onUpdate: progress / completed / error
  (transfer) => {
    wsApi.broadcast({ type: "transfer_update", transfer });
  },
);

// ─── Signaling Server (WebRTC — future remote phase) ─────────────────────────

createSignalingServer();

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(): void {
  console.log("\n[Agent] Shutting down…");
  mdns.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Banner ───────────────────────────────────────────────────────────────────

const ifaces = os.networkInterfaces();
const lanIps: string[] = [];
for (const iface of Object.values(ifaces)) {
  for (const addr of iface ?? []) {
    if (addr.family === "IPv4" && !addr.internal) lanIps.push(addr.address);
  }
}

console.log(`
╔══════════════════════════════════════════════════╗
║              NexDrop Agent — Ready               ║
╠══════════════════════════════════════════════════╣
║  Device : ${String(DEVICE_NAME).padEnd(38)} ║
║  LAN IP : ${(lanIps[0] ?? "unknown").padEnd(38)} ║
╠══════════════════════════════════════════════════╣
║  TCP receiver   :${String(TCP_PORT).padEnd(5)} (LAN file transfers)      ║
║  WS API         :${String(WS_API_PORT).padEnd(5)} (browser UI bridge)       ║
║  Signaling      :${String(SIGNALING_PORT).padEnd(5)} (WebRTC relay, E2EE)      ║
╠══════════════════════════════════════════════════╣
║  Browser → ws://localhost:${String(WS_API_PORT).padEnd(22)} ║
║  Tunnel: ALLOW_REMOTE_WS=true npm run dev        ║
╚══════════════════════════════════════════════════╝
`);
