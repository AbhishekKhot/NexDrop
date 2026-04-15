/**
 * index.ts — NexDrop local agent entrypoint.
 *
 * Services started:
 *  1. mDNS  — LAN peer discovery (advertise + browse)
 *  2. TCP server — receive incoming LAN file transfers
 *  3. WS API  — browser↔agent bridge (localhost:4001)
 *  4. Signaling server — WebRTC SDP/ICE relay (port 4002)
 *
 * Fixes applied:
 *  QUAL-03 — DOWNLOAD_DIR writability verified at startup before accepting transfers
 *  ERR-01  — mDNS errors broadcast to connected browsers
 */

import fs from "fs";
import os from "os";
import { MdnsService } from "./discovery/mdns";
import { createTcpServer, PendingDecisionMap } from "./transport/tcpServer";
import { sendFileToPeer } from "./transport/tcpClient";
import { createSignalingServer } from "./transport/signalingServer";
import { WsApiServer } from "./api/wsApi";
import {
  TCP_PORT,
  WS_API_PORT,
  SIGNALING_PORT,
  DEVICE_NAME,
  DOWNLOAD_DIR,
} from "./config";
import type { Peer, Transfer } from "./types";

// ─── Startup check — QUAL-03 ──────────────────────────────────────────────────

async function verifyDownloadDir(): Promise<void> {
  try {
    await fs.promises.mkdir(DOWNLOAD_DIR, { recursive: true });
    await fs.promises.access(DOWNLOAD_DIR, fs.constants.W_OK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[Startup] DOWNLOAD_DIR "${DOWNLOAD_DIR}" is not writable: ${msg}`,
    );
    process.exit(1);
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

const peers: Map<string, Peer> = new Map();
const pendingDecisions = new PendingDecisionMap();

// ─── mDNS ─────────────────────────────────────────────────────────────────────

const mdns = new MdnsService((updatedPeers) => {
  peers.clear();
  updatedPeers.forEach((p) => peers.set(p.id, p));
  wsApi.broadcast({ type: "peers_update", peers: updatedPeers });
});

// ERR-01: surface mDNS failures to all connected browsers
mdns.onError = (err) => {
  console.error("[mDNS] Error:", err.message);
  wsApi.broadcast({
    type: "error",
    message: "mDNS unavailable — LAN peer discovery may not work on this network",
    code: "MDNS_UNAVAILABLE",
  });
};

// ─── WS API (browser ↔ agent) ─────────────────────────────────────────────────

const wsApi = new WsApiServer(mdns.deviceId);

wsApi.onDiscoverPeers = () => {
  wsApi.broadcast({ type: "peers_update", peers: mdns.getPeers() });
};

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

// ─── Main startup ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // QUAL-03: verify download dir before accepting any connections
  await verifyDownloadDir();

  // Start mDNS after we know the download dir is ready
  mdns.advertise();
  mdns.browse();

  // TCP server (receive LAN files)
  createTcpServer(
    pendingDecisions,
    (transfer) => wsApi.broadcast({ type: "transfer_offer", transfer }),
    (transfer) => wsApi.broadcast({ type: "transfer_update", transfer }),
  );

  // Signaling server (WebRTC remote mode)
  createSignalingServer();

  // ─── Banner ───────────────────────────────────────────────────────────────
  const ifaces = os.networkInterfaces();
  const lanIps: string[] = [];
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) lanIps.push(addr.address);
    }
  }

  console.log(`
╔══════════════════════════════════════════════════                               ╗
║              NexDrop Agent — Ready                                              ║
╠══════════════════════════════════════════════════                               ╣
║  Device : ${String(DEVICE_NAME).padEnd(38)}                                     ║
║  LAN IP : ${(lanIps[0] ?? "unknown").padEnd(38)}                                ║
╠══════════════════════════════════════════════════                               ╣
║  TCP receiver   :${String(TCP_PORT).padEnd(5)} (LAN file transfers)             ║
║  WS API         :${String(WS_API_PORT).padEnd(5)} (browser UI bridge)           ║
║  Signaling      :${String(SIGNALING_PORT).padEnd(5)} (WebRTC relay, E2EE)       ║
╠══════════════════════════════════════════════════                               ╣
║  Browser → ws://localhost:${String(WS_API_PORT).padEnd(22)}                     ║
║  Tunnel: ALLOW_REMOTE_WS=true npm run dev                                       ║
╚══════════════════════════════════════════════════                               ╝
`);
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(): void {
  console.log("\n[Agent] Shutting down…");
  mdns.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[Agent] Fatal startup error:", err);
  process.exit(1);
});
