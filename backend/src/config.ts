import os from "os";

export const TCP_PORT = parseInt(process.env.TCP_PORT ?? "4000", 10);

export const WS_API_PORT = parseInt(process.env.WS_API_PORT ?? "4001", 10);

// Must stay in sync with frontend (agentSocket.ts and useRemoteTransfer.ts
// both define their own CHUNK_SIZE = 256 * 1024).
export const CHUNK_SIZE = 256 * 1024;

// Enforced at three points (tcpServer, tcpClient, agentSocket) — keep all
// three in sync if you raise the cap.
export const MAX_FILE_SIZE = parseInt(
  process.env.MAX_FILE_SIZE ?? String(2 * 1024 * 1024 * 1024),
  10,
);

// Enforced via net.Server.maxConnections so excess attempts are refused by
// the kernel before any application code runs.
export const TCP_MAX_CONNECTIONS = parseInt(
  process.env.TCP_MAX_CONNECTIONS ?? "20",
  10,
);

export const TCP_MAX_CONN_PER_IP = parseInt(
  process.env.TCP_MAX_CONN_PER_IP ?? "3",
  10,
);

// null means unlimited.
export const MAX_TRANSFER_BPS: number | null = process.env.MAX_TRANSFER_BPS
  ? parseInt(process.env.MAX_TRANSFER_BPS, 10)
  : null;

export const MDNS_SERVICE_TYPE = "peerdrop";

export const MDNS_PROTOCOL = "tcp";

export const MDNS_DISCOVER_TTL = 5_000;

export const WS_ALLOWED_ORIGIN =
  process.env.WS_ALLOWED_ORIGIN ?? "http://localhost:5173";

export const ALLOW_REMOTE_WS = process.env.ALLOW_REMOTE_WS === "true";

export const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR ?? os.homedir() + "/Downloads/NexDrop";

export const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();

// Frontend mirrors this with Web Crypto's namedCurve: 'P-256'.
export const ECDH_CURVE = "prime256v1";

// ── Remote relay (see docs/RELAY_PROTOCOL.md) ─────────────────────────
// The relay forwards end-to-end-encrypted file chunks between two browsers.
// Behind a TLS-terminating proxy it listens on plain ws bound to loopback.
export const RELAY_PORT = parseInt(process.env.RELAY_PORT ?? "4002", 10);

// Bind loopback by default — production sits behind a TLS-terminating proxy on
// the same host. Set 0.0.0.0 only inside a container or when no proxy is used.
export const RELAY_BIND_HOST = process.env.RELAY_BIND_HOST ?? "127.0.0.1";

// Comma-separated Origin allow-list checked on WS upgrade (CWE-352 / CSWSH).
export const RELAY_ALLOWED_ORIGINS = (
  process.env.RELAY_ALLOWED_ORIGIN ?? "http://localhost:5173"
)
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

// Trust X-Forwarded-For for client IP only behind a known proxy — otherwise it
// is an IP-spoofing vector for the rate limiter (CWE-348).
export const RELAY_TRUST_PROXY = process.env.RELAY_TRUST_PROXY === "true";

export const RELAY_MAX_CONN_PER_IP = parseInt(
  process.env.RELAY_MAX_CONN_PER_IP ?? "5",
  10,
);

export const RELAY_MAX_MSG_PER_SEC = parseInt(
  process.env.RELAY_MAX_MSG_PER_SEC ?? "20",
  10,
);

export const RELAY_MAX_FAILED_JOINS = parseInt(
  process.env.RELAY_MAX_FAILED_JOINS ?? "10",
  10,
);

export const RELAY_FAILED_JOIN_WINDOW_MS = parseInt(
  process.env.RELAY_FAILED_JOIN_WINDOW_MS ?? String(60_000),
  10,
);

// WAITING rooms (one peer) expire after this idle window.
export const RELAY_ROOM_TTL_MS = parseInt(
  process.env.RELAY_ROOM_TTL_MS ?? String(10 * 60 * 1000),
  10,
);

// Absolute cap even for active two-peer rooms — bounds covert-channel abuse.
export const RELAY_ROOM_ABSOLUTE_TTL_MS = parseInt(
  process.env.RELAY_ROOM_ABSOLUTE_TTL_MS ?? String(30 * 60 * 1000),
  10,
);

// Global resource bound — a lying/oversize transfer is hard-aborted (CWE-770).
export const RELAY_MAX_FILE_SIZE = parseInt(
  process.env.RELAY_MAX_FILE_SIZE ?? String(5 * 1024 * 1024 * 1024),
  10,
);

export const RELAY_MAX_CONTROL_FRAME = parseInt(
  process.env.RELAY_MAX_CONTROL_FRAME ?? String(16 * 1024),
  10,
);

// Pause the source socket when the destination's send buffer exceeds HIGH;
// resume below LOW. Keeps relay memory ~bounded regardless of file size.
export const RELAY_BACKPRESSURE_HIGH = parseInt(
  process.env.RELAY_BACKPRESSURE_HIGH ?? String(8 * 1024 * 1024),
  10,
);

export const RELAY_BACKPRESSURE_LOW = parseInt(
  process.env.RELAY_BACKPRESSURE_LOW ?? String(1 * 1024 * 1024),
  10,
);

// Remote path only — independent of LAN's 256 KiB CHUNK_SIZE.
export const RELAY_CHUNK_SIZE = 1024 * 1024;

// Bumped when the relay wire format changes incompatibly.
export const RELAY_PROTOCOL_VERSION = 1;

// parseInt without validation would return NaN for non-numeric strings, and
// net.Server would silently bind to port 0 (an ephemeral OS-assigned port).
function validatePort(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `Invalid port for ${name}: "${value}". Must be an integer between 1 and 65535.`,
    );
  }
}

validatePort("TCP_PORT", TCP_PORT);
validatePort("WS_API_PORT", WS_API_PORT);
validatePort("RELAY_PORT", RELAY_PORT);
