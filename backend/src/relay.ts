// Standalone entry point for the Remote-mode relay (see docs/RELAY_PROTOCOL.md).
// Deployed independently of the LAN agent (index.ts) — typically on a small
// cloud VM behind a TLS-terminating proxy. The LAN agent does not run this.
import { createRelayServer } from "./transport/relayServer";
import {
  RELAY_PORT,
  RELAY_BIND_HOST,
  RELAY_MAX_FILE_SIZE,
  RELAY_ALLOWED_ORIGINS,
} from "./config";

const relay = createRelayServer();

console.log(`
╔══════════════════════════════════════════════════╗
║            NexDrop Relay — Ready                  ║
╠══════════════════════════════════════════════════╣
║  Listen   : ${`${RELAY_BIND_HOST}:${RELAY_PORT}`.padEnd(36)} ║
║  Max file : ${`${Math.round(RELAY_MAX_FILE_SIZE / (1024 * 1024))} MiB`.padEnd(36)} ║
║  Origins  : ${RELAY_ALLOWED_ORIGINS.join(", ").slice(0, 36).padEnd(36)} ║
╚══════════════════════════════════════════════════╝
`);

function shutdown(): void {
  console.log("\n[Relay] Shutting down…");
  relay.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
