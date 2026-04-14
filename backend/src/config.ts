/**
 * config.ts
 * Central configuration for the NexDrop agent.
 * All tuneable values live here — override via environment variables.
 */

import os from "os";

/** TCP port the agent listens on for incoming file transfers (LAN) */
export const TCP_PORT = parseInt(process.env.TCP_PORT ?? "4000", 10);

/** WebSocket port the agent exposes to the browser UI */
export const WS_API_PORT = parseInt(process.env.WS_API_PORT ?? "4001", 10);

/** WebSocket port for the signaling server (remote WebRTC) */
export const SIGNALING_PORT = parseInt(
  process.env.SIGNALING_PORT ?? "4002",
  10,
);

/** Chunk size in bytes for splitting files (256 KB) */
export const CHUNK_SIZE = 256 * 1024;

/** mDNS service name for peer discovery */
export const MDNS_SERVICE_TYPE = "peerdrop";

/** mDNS service protocol */
export const MDNS_PROTOCOL = "tcp";

/** How long (ms) to listen for mDNS announcements during discovery */
export const MDNS_DISCOVER_TTL = 5_000;

/** CORS origin allowed for the WS API (browser) */
export const WS_ALLOWED_ORIGIN =
  process.env.WS_ALLOWED_ORIGIN ?? "http://localhost:5173";

/** Download directory for received files */
export const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR ?? os.homedir() + "/Downloads/NexDrop";

/** This device's human-readable name */
export const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();

/** ECDH curve for key exchange */
export const ECDH_CURVE = "prime256v1"; // P-256

// ── Signaling server rate limiting ──────────────────────────────────────────

/** Max concurrent WebSocket connections allowed per IP address */
export const SIGNALING_MAX_CONN_PER_IP = parseInt(
  process.env.SIGNALING_MAX_CONN_PER_IP ?? "5",
  10,
);

/** Max signaling messages per second per connection before the connection is dropped */
export const SIGNALING_MAX_MSG_PER_SEC = parseInt(
  process.env.SIGNALING_MAX_MSG_PER_SEC ?? "20",
  10,
);

/** How long (ms) a room stays alive without both peers connecting (creator-only room) */
export const SIGNALING_ROOM_TTL_MS = parseInt(
  process.env.SIGNALING_ROOM_TTL_MS ?? String(10 * 60 * 1000),
  10,
);
