import os from "os";

export const TCP_PORT = parseInt(process.env.TCP_PORT ?? "4000", 10);

export const WS_API_PORT = parseInt(process.env.WS_API_PORT ?? "4001", 10);

export const SIGNALING_PORT = parseInt(
  process.env.SIGNALING_PORT ?? "4002",
  10,
);

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

// Also controls whether X-Forwarded-For is trusted for client IP extraction
// in the signaling server.
export const ALLOW_REMOTE_WS = process.env.ALLOW_REMOTE_WS === "true";

export const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR ?? os.homedir() + "/Downloads/NexDrop";

export const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();

// Frontend mirrors this with Web Crypto's namedCurve: 'P-256'.
export const ECDH_CURVE = "prime256v1";

export const SIGNALING_MAX_CONN_PER_IP = parseInt(
  process.env.SIGNALING_MAX_CONN_PER_IP ?? "5",
  10,
);

export const SIGNALING_MAX_MSG_PER_SEC = parseInt(
  process.env.SIGNALING_MAX_MSG_PER_SEC ?? "20",
  10,
);

export const SIGNALING_ROOM_TTL_MS = parseInt(
  process.env.SIGNALING_ROOM_TTL_MS ?? String(10 * 60 * 1000),
  10,
);

// Absolute lifetime cap even for active two-peer rooms — prevents pairs from
// holding rooms open indefinitely as a covert channel.
export const SIGNALING_ROOM_ABSOLUTE_TTL_MS = parseInt(
  process.env.SIGNALING_ROOM_ABSOLUTE_TTL_MS ?? String(30 * 60 * 1000),
  10,
);

// Brute-force defence for 8-character share codes.
export const SIGNALING_MAX_FAILED_JOINS = parseInt(
  process.env.SIGNALING_MAX_FAILED_JOINS ?? "10",
  10,
);

export const SIGNALING_FAILED_JOIN_WINDOW_MS = parseInt(
  process.env.SIGNALING_FAILED_JOIN_WINDOW_MS ?? String(60_000),
  10,
);

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
validatePort("SIGNALING_PORT", SIGNALING_PORT);
