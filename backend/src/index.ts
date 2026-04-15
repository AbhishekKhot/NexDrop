/**
 * index.ts — NexDrop local agent entrypoint.
 *
 * Bootstraps all four services in dependency order:
 *  1. verifyDownloadDir() — QUAL-03: fail fast if download dir isn't writable
 *  2. MdnsService         — LAN peer advertising + discovery
 *  3. TCP server          — Receives incoming LAN file transfers
 *  4. WS API server       — Browser↔agent bridge (localhost:WS_API_PORT)
 *  5. Signaling server    — WebRTC SDP/ICE relay for remote mode
 *
 * Wiring pattern:
 * Services communicate through callbacks injected at construction time rather
 * than direct imports of each other.  This keeps the dependency graph acyclic:
 *   index.ts knows about all services; services know nothing about each other.
 *
 * Fixes applied:
 *  QUAL-03 — DOWNLOAD_DIR writability check before accepting any connections
 *  ERR-01  — mDNS errors broadcast to all connected browser tabs as toasts
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

// ── QUAL-03: Download directory writability check ─────────────────────────────

/**
 * Verify that DOWNLOAD_DIR exists and is writable before starting any services.
 *
 * Why verify at startup rather than on first transfer?
 * If the directory doesn't exist or isn't writable, every incoming file transfer
 * would succeed at the network level but fail at the disk-write step, producing
 * a confusing error for the user.  Failing loudly at startup gives a clear,
 * actionable message and avoids accepting files we can't save.
 *
 * mkdir with recursive:true is a no-op if the directory already exists, so this
 * doubles as a one-time directory creation step on first run.
 *
 * process.exit(1) is intentional — a non-writable download directory is a
 * configuration error that the operator must fix; retrying won't help.
 */
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

// ── Shared state ──────────────────────────────────────────────────────────────

/**
 * Live map of discovered LAN peers.
 * Updated by the mDNS onChange callback and read by wsApi.onSendFile.
 * Module-level (not inside main()) so it's accessible to all callbacks.
 */
const peers: Map<string, Peer> = new Map();

/**
 * Decision gate for incoming transfer prompts.
 * Created once; shared between tcpServer (registers decisions) and wsApi
 * (resolves them when the browser sends accept_transfer / reject_transfer).
 */
const pendingDecisions = new PendingDecisionMap();

// ── mDNS service ──────────────────────────────────────────────────────────────

/**
 * MdnsService is created before WsApiServer but its onChange callback references
 * wsApi.  This is safe because onChange only fires after browse() is called
 * inside main(), by which time wsApi is fully initialised.
 *
 * The onChange handler:
 *  1. Replaces the entire peers Map with the latest snapshot.
 *  2. Broadcasts a peers_update message to all connected browser tabs.
 */
const mdns = new MdnsService((updatedPeers) => {
  peers.clear();
  updatedPeers.forEach((p) => peers.set(p.id, p));
  wsApi.broadcast({ type: "peers_update", peers: updatedPeers });
});

/**
 * ERR-01: Surface mDNS failures to all connected browser tabs.
 *
 * mDNS can fail on restricted networks (corporate Wi-Fi, VPNs that block
 * multicast).  Rather than silently degrading, we broadcast an error toast
 * so the user knows LAN peer discovery is unavailable and why.
 *
 * The machine-readable code 'MDNS_UNAVAILABLE' lets the frontend distinguish
 * this error from others and potentially show more contextual help.
 *
 * Assigned after mdns construction because onError is an optional property,
 * not a constructor parameter.
 */
mdns.onError = (err) => {
  console.error("[mDNS] Error:", err.message);
  wsApi.broadcast({
    type: "error",
    message: "mDNS unavailable — LAN peer discovery may not work on this network",
    code: "MDNS_UNAVAILABLE",
  });
};

// ── WS API server ─────────────────────────────────────────────────────────────

/**
 * Created at module load time (before main()) because mDNS.onError references it.
 * The WsApiServer constructor starts listening immediately — this is acceptable
 * because it only accepts localhost connections and won't be exploited before
 * the download dir is verified.
 */
const wsApi = new WsApiServer(mdns.deviceId);

/**
 * When the browser requests a peer list refresh, push the current mDNS snapshot.
 * This is a pull-on-demand pattern — the browser calls onDiscoverPeers() when
 * the user clicks "Scan" rather than the agent broadcasting on a fixed interval.
 */
wsApi.onDiscoverPeers = () => {
  wsApi.broadcast({ type: "peers_update", peers: mdns.getPeers() });
};

/**
 * When the browser has streamed a complete file to the agent, initiate the
 * TCP transfer to the target peer.
 *
 * Validation:
 *  - Check that the peer is still in the discovered peers map (it may have
 *    gone offline between file selection and send).
 *  - Check that the peer has IP/port (all LAN peers should; this guard
 *    prevents a confusing "Cannot connect to undefined" error further down).
 *
 * The sendFileToPeer() result (success/error) is relayed to the browser
 * via the onUpdate callback, which calls wsApi.broadcast(transfer_update).
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
        // Relay every transfer state change to all browser tabs
        wsApi.broadcast({ type: "transfer_update", transfer });
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Send failed:`, message);
    wsApi.broadcast({ type: "error", message: `Send failed: ${message}` });
  }
};

/**
 * Bridge accept/reject decisions from the browser to the TCP server's pending
 * decision map.  The TCP server is suspended waiting for these resolutions.
 */
wsApi.onAcceptTransfer = (transferId) => {
  pendingDecisions.respond(transferId, true);
};

wsApi.onRejectTransfer = (transferId) => {
  pendingDecisions.respond(transferId, false);
};

// ── Main startup ──────────────────────────────────────────────────────────────

/**
 * Ordered startup sequence.
 *
 * Services are started after verifyDownloadDir() so we never accept an
 * incoming file transfer before we know we can write it to disk.
 *
 * The startup banner collects all non-loopback IPv4 addresses from all network
 * interfaces so the user can see which address their LAN peers will connect to.
 */
async function main(): Promise<void> {
  // QUAL-03: hard stop if download dir isn't writable
  await verifyDownloadDir();

  // Start LAN peer advertising + discovery
  mdns.advertise();
  mdns.browse();

  // TCP server: receives incoming LAN file transfers from peers
  createTcpServer(
    pendingDecisions,
    (transfer) => wsApi.broadcast({ type: "transfer_offer", transfer }),
    (transfer) => wsApi.broadcast({ type: "transfer_update", transfer }),
  );

  // Signaling server: WebRTC SDP/ICE relay for remote mode
  createSignalingServer();

  // ── Startup banner ────────────────────────────────────────────────────────
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

// ── Graceful shutdown ─────────────────────────────────────────────────────────

/**
 * Clean shutdown on SIGINT (Ctrl-C) and SIGTERM (Docker stop, kill).
 *
 * mdns.destroy() unpublishes the service announcement and stops browsing,
 * which causes remote peers to see this device disappear from their peer list
 * almost immediately rather than waiting for the mDNS TTL to expire.
 */
function shutdown(): void {
  console.log("\n[Agent] Shutting down…");
  mdns.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/**
 * Top-level error handler for main().
 * Any unhandled rejection in the startup sequence (e.g. port already in use)
 * produces a clear error message and exits with a non-zero code.
 */
main().catch((err) => {
  console.error("[Agent] Fatal startup error:", err);
  process.exit(1);
});
