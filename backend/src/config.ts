/**
 * config.ts
 * Central configuration for the NexDrop agent.
 *
 * All tuneable values live here — override via environment variables at runtime.
 * Keeping everything in one place means the rest of the codebase never calls
 * process.env directly, which makes it easy to audit what the agent exposes and
 * to write tests that inject custom values.
 *
 * Port validation runs at module load time (bottom of file) so a misconfigured
 * deployment fails loudly on startup rather than silently misbehaving later.
 */

import os from "os";

// ── Network ports ─────────────────────────────────────────────────────────────

/** TCP port the agent listens on for incoming file transfers (LAN mode) */
export const TCP_PORT = parseInt(process.env.TCP_PORT ?? "4000", 10);

/** WebSocket port the agent exposes to the browser UI (localhost only by default) */
export const WS_API_PORT = parseInt(process.env.WS_API_PORT ?? "4001", 10);

/** WebSocket port for the signaling server used by WebRTC remote mode */
export const SIGNALING_PORT = parseInt(
  process.env.SIGNALING_PORT ?? "4002",
  10,
);

// ── Transfer limits ───────────────────────────────────────────────────────────

/**
 * Chunk size in bytes for splitting files (256 KB).
 *
 * 256 KB is a deliberate balance:
 *  - Large enough that per-chunk AES-GCM overhead is negligible.
 *  - Small enough to fit comfortably within a WebRTC DataChannel send buffer
 *    without triggering backpressure on every single write.
 *  - Matches TCP's typical optimal write size for streaming payloads.
 *
 * IMPORTANT: this constant must stay in sync with the frontend (agentSocket.ts
 * and useRemoteTransfer.ts both define their own CHUNK_SIZE = 256 * 1024).
 */
export const CHUNK_SIZE = 256 * 1024;

/**
 * Maximum allowed file size in bytes (default 2 GB) — SEC-01/02/03.
 *
 * Enforced at three points:
 *  SEC-01 — tcpServer: reject METADATA frame if fileSize > limit
 *  SEC-02 — tcpClient: reject before opening a socket
 *  SEC-03 — agentSocket (browser): reject before streaming to agent
 *
 * Keeping the default at 2 GB prevents OOM on low-RAM devices while still
 * accommodating most common file types (video, disk images, archives).
 */
export const MAX_FILE_SIZE = parseInt(
  process.env.MAX_FILE_SIZE ?? String(2 * 1024 * 1024 * 1024),
  10,
);

// ── TCP connection limits (LOAD-01) ───────────────────────────────────────────

/**
 * Maximum number of simultaneous TCP connections the server will accept globally.
 *
 * Node's net.Server.maxConnections enforces this at the OS accept() level,
 * so excess connection attempts are queued or refused by the kernel before
 * any application code even runs — very cheap to enforce.
 */
export const TCP_MAX_CONNECTIONS = parseInt(
  process.env.TCP_MAX_CONNECTIONS ?? "20",
  10,
);

/**
 * Maximum simultaneous TCP connections allowed from a single remote IP.
 *
 * Tracked at the application level (see tcpServer.ts ipConnections map).
 * Set lower than the global cap to prevent one host from monopolising the
 * server and starving other peers.
 */
export const TCP_MAX_CONN_PER_IP = parseInt(
  process.env.TCP_MAX_CONN_PER_IP ?? "3",
  10,
);

/**
 * Optional token-bucket rate limit for outbound TCP sends, in bytes/second.
 * null means unlimited (default) — useful for lab networks where you don't
 * want a single transfer to saturate the NIC and block mDNS traffic.
 *
 * Example: MAX_TRANSFER_BPS=10485760 caps sends at 10 MB/s.
 */
export const MAX_TRANSFER_BPS: number | null = process.env.MAX_TRANSFER_BPS
  ? parseInt(process.env.MAX_TRANSFER_BPS, 10)
  : null;

// ── mDNS peer discovery ───────────────────────────────────────────────────────

/** mDNS service name the agent registers and searches for on the LAN */
export const MDNS_SERVICE_TYPE = "peerdrop";

/** mDNS transport protocol — must match Bonjour's expectation for TCP services */
export const MDNS_PROTOCOL = "tcp";

/** How long (ms) to passively listen for mDNS announcements during a discovery scan */
export const MDNS_DISCOVER_TTL = 5_000;

// ── WebSocket API security ─────────────────────────────────────────────────────

/**
 * CORS origin allowed for the WS API.
 * The browser enforces this; the agent validates the Origin header on upgrade.
 */
export const WS_ALLOWED_ORIGIN =
  process.env.WS_ALLOWED_ORIGIN ?? "http://localhost:5173";

/**
 * Allow non-localhost WebSocket connections (e.g. via ngrok or a reverse proxy).
 *
 * Defaults to false so the agent is safe to run on multi-user machines —
 * only the local browser tab can talk to it.  Set to true only when tunnelling.
 *
 * Also controls whether X-Forwarded-For is trusted for client IP extraction
 * in the signaling server (SEC-06).
 */
export const ALLOW_REMOTE_WS = process.env.ALLOW_REMOTE_WS === "true";

// ── File storage ──────────────────────────────────────────────────────────────

/** Directory where received files are saved. Created at startup if absent. */
export const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR ?? os.homedir() + "/Downloads/NexDrop";

// ── Device identity ───────────────────────────────────────────────────────────

/** Human-readable name for this device — shown in peer lists of remote devices */
export const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();

// ── Cryptography ──────────────────────────────────────────────────────────────

/**
 * ECDH curve for LAN-mode key exchange.
 * P-256 is chosen because:
 *  - Native support in every Node.js version via OpenSSL.
 *  - The frontend mirrors it with the Web Crypto API (namedCurve: 'P-256').
 *  - 128-bit security level — well above what's needed for ephemeral file transfer keys.
 */
export const ECDH_CURVE = "prime256v1"; // P-256

// ── Signaling server rate limiting ────────────────────────────────────────────

/**
 * Max concurrent WebSocket connections allowed per IP address on the signaling server.
 *
 * The signaling server only relays SDP/ICE — it never sees file bytes.
 * Even so, uncapped connections would let one IP exhaust the event loop or
 * create millions of rooms. This cap is intentionally tight.
 */
export const SIGNALING_MAX_CONN_PER_IP = parseInt(
  process.env.SIGNALING_MAX_CONN_PER_IP ?? "5",
  10,
);

/**
 * Max signaling messages per second per connection.
 *
 * A sliding-window counter resets every 1 second. Connections that exceed
 * this are terminated immediately. 20/s is far more than a legitimate WebRTC
 * handshake needs (typically 3–6 messages total).
 */
export const SIGNALING_MAX_MSG_PER_SEC = parseInt(
  process.env.SIGNALING_MAX_MSG_PER_SEC ?? "20",
  10,
);

/**
 * How long (ms) a room stays alive while only the creator has joined.
 *
 * If the second peer never shows up within this window, the room is destroyed.
 * This prevents the server accumulating rooms for abandoned share codes.
 * Cleared the moment a second peer successfully joins.
 */
export const SIGNALING_ROOM_TTL_MS = parseInt(
  process.env.SIGNALING_ROOM_TTL_MS ?? String(10 * 60 * 1000),
  10,
);

/**
 * Absolute maximum room lifetime regardless of how many peers are connected — SEC-08.
 *
 * Even active two-peer rooms are closed after this TTL. This prevents a
 * pair of peers from holding a room open indefinitely (leaking server state
 * or serving as a persistent covert channel through the signaling relay).
 */
export const SIGNALING_ROOM_ABSOLUTE_TTL_MS = parseInt(
  process.env.SIGNALING_ROOM_ABSOLUTE_TTL_MS ?? String(30 * 60 * 1000),
  10,
);

/**
 * Max failed join attempts per IP before the connection is terminated — SEC-07.
 *
 * Each attempt to join a non-existent or full room increments a counter.
 * Exceeding this limit terminates the WebSocket — a lightweight defence
 * against brute-forcing 8-character share codes (62^8 ≈ 218 trillion combos).
 */
export const SIGNALING_MAX_FAILED_JOINS = parseInt(
  process.env.SIGNALING_MAX_FAILED_JOINS ?? "10",
  10,
);

/**
 * Sliding window (ms) in which failed-join attempts are counted — SEC-07.
 *
 * After SIGNALING_FAILED_JOIN_WINDOW_MS milliseconds the counter resets,
 * allowing a legitimate user who mistyped a code to try again after a minute.
 */
export const SIGNALING_FAILED_JOIN_WINDOW_MS = parseInt(
  process.env.SIGNALING_FAILED_JOIN_WINDOW_MS ?? String(60_000),
  10,
);

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Validate that a parsed port value is a valid TCP/UDP port number.
 *
 * Called at module load time for all three port constants so that a typo
 * (e.g. TCP_PORT=abc or TCP_PORT=99999) throws an Error immediately on
 * process start rather than silently binding to port 0 or NaN.
 *
 * Using parseInt without validation would return NaN for non-numeric strings,
 * and Node's net.Server would happily bind to port 0 (an ephemeral OS-assigned
 * port) — almost impossible to debug from logs alone.
 */
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
