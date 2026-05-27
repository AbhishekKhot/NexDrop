import fs from "fs";
import os from "os";
import { MdnsService } from "./discovery/mdns";
import { createTcpServer, PendingDecisionMap } from "./transport/tcpServer";
import { sendFileToPeer } from "./transport/tcpClient";
import { WsApiServer } from "./api/wsApi";
import {
  TCP_PORT,
  WS_API_PORT,
  DEVICE_NAME,
  DOWNLOAD_DIR,
} from "./config";
import type { Peer, Transfer } from "./types";

// Fail fast at startup rather than per-transfer: an unwritable DOWNLOAD_DIR
// would let transfers succeed on the network but fail at disk-write.
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

const peers: Map<string, Peer> = new Map();

const pendingDecisions = new PendingDecisionMap();

// onChange only fires after browse() is called inside main(), by which time
// wsApi is fully initialised.
const mdns = new MdnsService((updatedPeers) => {
  peers.clear();
  updatedPeers.forEach((p) => peers.set(p.id, p));
  wsApi.broadcast({ type: "peers_update", peers: updatedPeers });
});

// mDNS can fail on restricted networks (corporate Wi-Fi, VPNs that block
// multicast); surface that to the UI rather than silently degrading.
mdns.onError = (err) => {
  console.error("[mDNS] Error:", err.message);
  wsApi.broadcast({
    type: "error",
    message: "mDNS unavailable — LAN peer discovery may not work on this network",
    code: "MDNS_UNAVAILABLE",
  });
};

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
      mdns.deviceId,
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

async function main(): Promise<void> {
  await verifyDownloadDir();

  mdns.advertise();
  mdns.browse();

  createTcpServer(
    pendingDecisions,
    (transfer) => wsApi.broadcast({ type: "transfer_offer", transfer }),
    (transfer) => wsApi.broadcast({ type: "transfer_update", transfer }),
  );

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
╠══════════════════════════════════════════════════                               ╣
║  Browser → ws://localhost:${String(WS_API_PORT).padEnd(22)}                     ║
║  Tunnel: ALLOW_REMOTE_WS=true npm run dev                                       ║
╚══════════════════════════════════════════════════                               ╝
`);
}

// destroy() unpublishes immediately so peers see the device disappear without
// waiting for the mDNS TTL.
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
