/**
 * signalingServer.ts
 * Lightweight WebSocket relay for WebRTC remote-mode peer negotiation.
 *
 * IMPORTANT: This server NEVER touches file bytes.
 * Its only job is to relay the minimum information two browsers need to
 * establish a direct WebRTC DataChannel:
 *  - SDP offer / answer  (session capabilities negotiation)
 *  - ICE candidates       (network path discovery for NAT traversal)
 *
 * Once both browsers have exchanged this information via the signaling server,
 * they communicate directly peer-to-peer (DTLS-encrypted DataChannel).
 * The signaling server drops out of the picture entirely.
 *
 * Room model:
 *  A "room" is identified by an 8-character uppercase share code (e.g. "A3F9BC2E").
 *  The creator shares this code out-of-band (copy/paste, QR code, etc.).
 *  The joiner enters it in the UI.  Rooms are strictly 2-peer; a third peer
 *  trying to join receives an error.
 *
 * Security hardening applied:
 *  SEC-06 — X-Forwarded-For only trusted when ALLOW_REMOTE_WS=true (behind a proxy);
 *            last hop is taken to prevent IP spoofing by the client.
 *  SEC-07 — Per-IP failed-join counter; connection terminated after N failures
 *            within a sliding window (brute-force protection for share codes).
 *  SEC-08 — Absolute room TTL fires regardless of peer count, preventing rooms
 *            from being held open indefinitely as covert relay channels.
 *
 * Rate limiting:
 *  - Per-IP connection cap (SIGNALING_MAX_CONN_PER_IP)
 *  - Per-connection message rate (SIGNALING_MAX_MSG_PER_SEC per second)
 */

import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import crypto from "crypto";
import {
  SIGNALING_PORT,
  SIGNALING_MAX_CONN_PER_IP,
  SIGNALING_MAX_MSG_PER_SEC,
  SIGNALING_ROOM_TTL_MS,
  SIGNALING_ROOM_ABSOLUTE_TTL_MS,
  SIGNALING_MAX_FAILED_JOINS,
  SIGNALING_FAILED_JOIN_WINDOW_MS,
  ALLOW_REMOTE_WS,
} from "../config";

// ── SEC-11: Share-code generation ─────────────────────────────────────────────

/**
 * Crockford-style base32 alphabet excluding the ambiguous characters
 *  0 (zero) ↔ O    1 (one) ↔ I, L
 * leaving exactly 32 symbols.  32 is a power of two, so `byte & 0x1f` produces
 * a uniformly distributed index — no modulo bias, no rejection sampling needed.
 */
const SHARE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars
/**
 * 10 characters × 5 bits = 50 bits of entropy ≈ 1.1×10^15 combinations.
 *
 * Previous implementation used `uuidv4().slice(0,8).toUpperCase()`, which only
 * emitted hex digits [0-9A-F] for an effective key space of 16^8 ≈ 4.3×10^9 —
 * an order of magnitude smaller than the comments claimed.  The new code is
 * uniformly distributed across the 32-symbol alphabet via crypto.randomBytes
 * (CSPRNG), with the per-IP failed-join cap providing brute-force resistance
 * on top of the entropy.
 */
const SHARE_CODE_LENGTH = 10;

/**
 * Generate a uniformly random share code using a CSPRNG.
 * Caller is responsible for collision-checking against the live rooms map.
 */
function generateShareCode(): string {
  const bytes = crypto.randomBytes(SHARE_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    // 32 symbols, mask the low 5 bits — zero modulo bias since 32 | 256
    out += SHARE_CODE_ALPHABET[bytes[i] & 0x1f];
  }
  return out;
}

/**
 * A signaling room with at most 2 peers.
 *
 * Two timers guard each room's lifetime:
 *  expiryTimer   — cancelled when the second peer joins; fires if the creator
 *                  waits too long without anyone joining (SIGNALING_ROOM_TTL_MS).
 *  absoluteTimer — fires unconditionally after SIGNALING_ROOM_ABSOLUTE_TTL_MS,
 *                  even if both peers are actively connected (SEC-08).
 *
 * Why an absolute TTL?
 * Without it, two peers could keep a room alive indefinitely.  This leaks server
 * state, and — more importantly — the signaling server would function as a
 * persistent channel between two browsers after their WebRTC connection ended,
 * which was never its intended purpose.
 */
interface Room {
  id: string;
  peers: WebSocket[];
  expiryTimer: NodeJS.Timeout | null;
  absoluteTimer: NodeJS.Timeout; // SEC-08
}

/** Plain SDP type — avoids importing browser-only RTCSessionDescriptionInit */
export type SessionDescription = { type: "offer" | "answer"; sdp: string };
/** Plain ICE candidate — avoids importing browser-only RTCIceCandidateInit */
export type IceCandidate = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

export type SignalingMessage =
  | { type: "joined"; roomId: string }
  | { type: "offer"; sdp: SessionDescription }
  | { type: "answer"; sdp: SessionDescription }
  | { type: "ice"; candidate: IceCandidate }
  | { type: "peer_joined" }
  | { type: "peer_left" }
  | { type: "error"; message: string };

// ── Per-connection rate limiting ──────────────────────────────────────────────

/**
 * Sliding-window message counter for one WebSocket connection.
 *
 * Resets every second.  If msgCount exceeds SIGNALING_MAX_MSG_PER_SEC within
 * a 1-second window the connection is terminated.
 *
 * Why sliding window instead of token bucket?
 * The signaling protocol sends very few messages (3–6 total for a handshake).
 * A simple counter is sufficient and avoids the complexity of a token bucket
 * for a limit that legitimate peers will never approach.
 */
interface ConnState {
  ip: string;
  msgCount: number;
  windowStart: number; // unix ms when the current 1-second window started
}

/**
 * Check whether this connection is within its per-second message budget.
 *
 * Returns true if the message is allowed; false if the rate limit is exceeded.
 * Mutates state.msgCount and state.windowStart in place to avoid allocations
 * on the hot path.
 */
function checkRateLimit(state: ConnState): boolean {
  const now = Date.now();
  if (now - state.windowStart >= 1000) {
    // New 1-second window — reset counter
    state.msgCount = 1;
    state.windowStart = now;
    return true;
  }
  state.msgCount++;
  return state.msgCount <= SIGNALING_MAX_MSG_PER_SEC;
}

// ── Per-IP connection tracking ────────────────────────────────────────────────

/**
 * Maps each client IP to the set of WebSocket connections it currently holds.
 *
 * Using a Set<WebSocket> (rather than a counter) allows untrackConnection() to
 * remove the exact socket object, preventing the count from drifting out of sync
 * if the same socket is removed twice (e.g. both 'close' and 'error' fire).
 */
const ipSockets = new Map<string, Set<WebSocket>>();

/**
 * Register a new connection for an IP.
 * Returns false if the IP has already reached SIGNALING_MAX_CONN_PER_IP —
 * caller should reject the connection immediately.
 */
function trackConnection(ip: string, ws: WebSocket): boolean {
  let sockets = ipSockets.get(ip);
  if (!sockets) {
    sockets = new Set();
    ipSockets.set(ip, sockets);
  }
  if (sockets.size >= SIGNALING_MAX_CONN_PER_IP) return false;
  sockets.add(ws);
  return true;
}

/**
 * Remove a connection from an IP's tracked set.
 * Deletes the IP entry entirely when its set becomes empty to avoid
 * unbounded Map growth over long uptime.
 */
function untrackConnection(ip: string, ws: WebSocket): void {
  const sockets = ipSockets.get(ip);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) ipSockets.delete(ip);
}

// ── SEC-07: Failed-join brute-force protection ────────────────────────────────

/**
 * Tracks failed room-join attempts per IP within a sliding time window.
 *
 * A "failed join" is any attempt to join a room that:
 *  a) doesn't exist (wrong / expired share code), or
 *  b) is already full (two peers already connected).
 *
 * When an IP exceeds SIGNALING_MAX_FAILED_JOINS failures within
 * SIGNALING_FAILED_JOIN_WINDOW_MS, its WebSocket is terminated.
 *
 * SEC-11: the share code is 10 characters drawn uniformly from a 32-symbol
 * alphabet via CSPRNG, giving 2^50 ≈ 1.1×10^15 combinations.  Combined with
 * the per-IP rate limit below, brute-force enumeration is computationally
 * infeasible.  This counter mainly exists to prevent abuse of the signaling
 * server as a probing tool for live rooms.
 */
interface FailedJoinRecord {
  count: number;
  windowStart: number; // unix ms when the current window started
}

const failedJoins = new Map<string, FailedJoinRecord>();

/**
 * Record a failed join attempt for an IP.
 *
 * Returns true if the IP has now exceeded the limit (caller should terminate
 * the connection); false if the IP is still within the allowed window.
 *
 * The window resets on each call when the previous window has expired,
 * allowing a legitimate user who mistyped a code to try again after a minute.
 */
function recordFailedJoin(ip: string): boolean {
  const now = Date.now();
  let rec = failedJoins.get(ip);

  if (!rec || now - rec.windowStart >= SIGNALING_FAILED_JOIN_WINDOW_MS) {
    // First failure or window expired — start fresh
    rec = { count: 1, windowStart: now };
  } else {
    rec.count++;
  }
  failedJoins.set(ip, rec);

  return rec.count > SIGNALING_MAX_FAILED_JOINS;
}

/**
 * Remove the failed-join record for an IP after a successful join.
 * Prevents a legitimate user from being locked out after a few typos
 * followed by a successful connection.
 */
function clearFailedJoins(ip: string): void {
  failedJoins.delete(ip);
}

/**
 * Periodic cleanup of stale failed-join records (every 5 minutes).
 *
 * Without this, IPs that fail a few times and then go away would accumulate
 * in the Map indefinitely.  The interval is much longer than the window so
 * cleanup is infrequent and cheap.
 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of failedJoins) {
    if (now - rec.windowStart >= SIGNALING_FAILED_JOIN_WINDOW_MS) {
      failedJoins.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ── SEC-06: Safe client IP extraction ────────────────────────────────────────

/**
 * Extract the real client IP from the HTTP upgrade request.
 *
 * Why not always trust X-Forwarded-For?
 * XFF is trivially spoofable by the client.  If we trusted it unconditionally,
 * an attacker could set XFF: 1.2.3.4 and exhaust the connection limit for
 * an arbitrary IP address, effectively locking out innocent users.
 *
 * We only trust XFF when ALLOW_REMOTE_WS=true, which signals that a trusted
 * reverse proxy (Caddy, nginx) is in front of the server and is responsible
 * for appending the real client IP.
 *
 * When trusting XFF, we take the LAST entry (".at(-1)"), not the first.
 * The first entry is controlled by the client; the last entry is appended
 * by the trusted proxy and cannot be spoofed.
 *
 * Example: XFF: "1.2.3.4, 5.6.7.8"  →  we use "5.6.7.8" (proxy-appended).
 */
function getClientIp(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? "unknown";

  if (ALLOW_REMOTE_WS) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const raw = Array.isArray(xff) ? xff[0] : xff;
      const lastHop = raw.split(",").at(-1)?.trim();
      if (lastHop) return lastHop;
    }
  }

  return direct;
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create and start the WebRTC signaling server.
 *
 * Returns the WebSocketServer instance so callers can attach additional
 * event listeners or shut it down gracefully if needed.
 */
export function createSignalingServer(): WebSocketServer {
  const wss = new WebSocketServer({ port: SIGNALING_PORT });
  const rooms = new Map<string, Room>();

  /**
   * Destroy a room and disconnect all its peers with an explanation message.
   *
   * Centralising teardown here prevents the three callers (expiry timer,
   * absolute timer, ws.on('close') when room becomes empty) from each
   * duplicating the cleanup logic and risking leaking a timer handle.
   *
   * @param roomId  The room to destroy.
   * @param reason  Human-readable explanation sent to each peer as an error message.
   */
  function destroyRoom(roomId: string, reason: string): void {
    const room = rooms.get(roomId);
    if (!room) return;
    // Clear both timers before sending messages — avoids a second destroyRoom()
    // call from the timer firing while we're already tearing down
    if (room.expiryTimer) clearTimeout(room.expiryTimer);
    clearTimeout(room.absoluteTimer);
    for (const peer of room.peers) {
      send(peer, { type: "error", message: reason });
      peer.close();
    }
    rooms.delete(roomId);
    console.log(`[Signaling] Room destroyed: ${roomId} — ${reason}`);
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const ip = getClientIp(req); // SEC-06: safe IP extraction

    // ── Per-IP connection limit ──────────────────────────────────────────────
    // Checked first, before any message processing, to minimise work for
    // abusive connections.
    if (!trackConnection(ip, ws)) {
      send(ws, {
        type: "error",
        message: "Too many connections from your IP. Try again later.",
      });
      ws.terminate(); // terminate() (not close()) sends no FIN — faster for abusers
      console.warn(`[Signaling] Rejected connection from ${ip} (limit reached)`);
      return;
    }

    // currentRoomId tracks which room this connection belongs to.
    // null means the peer hasn't joined or created a room yet.
    let currentRoomId: string | null = null;
    const connState: ConnState = { ip, msgCount: 0, windowStart: Date.now() };

    ws.on("message", (raw) => {
      // ── Rate limit check ──────────────────────────────────────────────────
      // Applied to every message before any parsing so even malformed JSON
      // counts toward the limit.
      if (!checkRateLimit(connState)) {
        send(ws, { type: "error", message: "Rate limit exceeded." });
        ws.terminate();
        console.warn(`[Signaling] Rate limit exceeded: closing ${ip}`);
        return;
      }

      let msg: {
        type: string;
        roomId?: string;
        sdp?: unknown;
        candidate?: unknown;
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      // ── Create room ────────────────────────────────────────────────────────
      if (msg.type === "create") {
        if (currentRoomId) {
          send(ws, { type: "error", message: "Already in a room" });
          return;
        }

        // SEC-11: CSPRNG share code with collision check.
        // 32-symbol alphabet × 10 chars = 50 bits of entropy.  Collisions are
        // astronomically unlikely, but a check-and-regenerate loop bounds the
        // worst case deterministically and prevents the previous version's
        // silent room overwrite if a collision did occur.
        let roomId = generateShareCode();
        for (let attempt = 0; rooms.has(roomId) && attempt < 5; attempt++) {
          roomId = generateShareCode();
        }
        if (rooms.has(roomId)) {
          // 5 collisions in a row from a 2^50 space means RNG failure or a
          // catastrophic number of live rooms — refuse rather than overwrite.
          send(ws, {
            type: "error",
            message: "Unable to allocate a unique room ID. Try again.",
          });
          return;
        }

        // Expiry timer: destroy room if second peer never joins
        const expiryTimer = setTimeout(() => {
          const room = rooms.get(roomId);
          if (room && room.peers.length < 2) {
            destroyRoom(roomId, "Room expired — no peer joined in time.");
          }
        }, SIGNALING_ROOM_TTL_MS);

        // SEC-08: absolute TTL regardless of peer count.
        // Even if both peers join and stay connected, the room is closed after
        // this timeout.  File transfers should complete well within 30 minutes;
        // any room still open after that is either abandoned or misused.
        const absoluteTimer = setTimeout(() => {
          destroyRoom(roomId, "Room reached maximum lifetime and was closed.");
        }, SIGNALING_ROOM_ABSOLUTE_TTL_MS);

        const room: Room = {
          id: roomId,
          peers: [ws],
          expiryTimer,
          absoluteTimer,
        };
        rooms.set(roomId, room);
        currentRoomId = roomId;
        send(ws, { type: "joined", roomId });
        console.log(`[Signaling] Room created: ${roomId} by ${ip}`);
        return;
      }

      // ── Join room ──────────────────────────────────────────────────────────
      if (msg.type === "join" && msg.roomId) {
        if (currentRoomId) {
          send(ws, { type: "error", message: "Already in a room" });
          return;
        }

        // SEC-07: pre-flight check before room lookup.
        // We check the counter BEFORE looking up the room so that even a
        // previously-blocked IP can't probe whether a room exists.
        if (
          failedJoins.get(ip) &&
          failedJoins.get(ip)!.count >= SIGNALING_MAX_FAILED_JOINS
        ) {
          send(ws, {
            type: "error",
            message: "Too many failed join attempts. Try again later.",
          });
          ws.terminate();
          console.warn(
            `[Signaling] Failed-join limit reached for ${ip} — terminated`,
          );
          return;
        }

        const room = rooms.get(msg.roomId);

        // Room not found — wrong or expired share code
        if (!room) {
          send(ws, { type: "error", message: `Room ${msg.roomId} not found` });
          if (recordFailedJoin(ip)) {
            console.warn(`[Signaling] ${ip} exceeded failed-join limit`);
            ws.terminate();
          }
          return;
        }

        // Room full — two peers already connected
        if (room.peers.length >= 2) {
          send(ws, { type: "error", message: "Room is full" });
          if (recordFailedJoin(ip)) {
            console.warn(`[Signaling] ${ip} exceeded failed-join limit`);
            ws.terminate();
          }
          return;
        }

        // Successful join — reset the failed-join counter so a few typos
        // don't accidentally block this IP after a successful connection
        clearFailedJoins(ip);

        // Cancel the one-sided expiry timer now that both peers are present
        if (room.expiryTimer) {
          clearTimeout(room.expiryTimer);
          room.expiryTimer = null;
        }

        room.peers.push(ws);
        currentRoomId = room.id;
        send(ws, { type: "joined", roomId: room.id });
        // Notify the first peer that someone joined so it can initiate the WebRTC offer
        relay(room, ws, { type: "peer_joined" });
        console.log(`[Signaling] Peer joined room: ${room.id} from ${ip}`);
        return;
      }

      // ── Relay SDP offer / answer / ICE candidate ───────────────────────────
      // These are the actual WebRTC negotiation messages — forwarded verbatim
      // to the other peer in the room.  The signaling server doesn't inspect
      // or modify their contents (it has no need to and doing so could break
      // the WebRTC handshake).
      if (currentRoomId && ["offer", "answer", "ice"].includes(msg.type)) {
        const room = rooms.get(currentRoomId);
        if (room) relay(room, ws, msg as SignalingMessage);
        return;
      }

      send(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
    });

    ws.on("close", () => {
      untrackConnection(ip, ws);
      if (!currentRoomId) return;

      const room = rooms.get(currentRoomId);
      if (!room) return;

      // Cancel the expiry timer (it only fires for solo rooms anyway, but
      // clearing it prevents a potential stale callback after room deletion)
      if (room.expiryTimer) {
        clearTimeout(room.expiryTimer);
        room.expiryTimer = null;
      }

      // Notify the remaining peer that their partner disconnected
      relay(room, ws, { type: "peer_left" });
      room.peers = room.peers.filter((p) => p !== ws);

      if (room.peers.length === 0) {
        // Both peers gone — cancel the absolute TTL and remove the room.
        // Without this, the absoluteTimer would hold a reference to the
        // room Map entry and fire destroyRoom() on an already-deleted room.
        clearTimeout(room.absoluteTimer);
        rooms.delete(currentRoomId);
        console.log(`[Signaling] Room destroyed: ${currentRoomId}`);
      }
    });

    ws.on("error", (err) => {
      console.error("[Signaling] WS error:", err.message);
    });
  });

  wss.on("listening", () => {
    console.log(
      `[Signaling] Server on port ${SIGNALING_PORT} ` +
        `(max ${SIGNALING_MAX_CONN_PER_IP} conn/IP, ` +
        `${SIGNALING_MAX_MSG_PER_SEC} msg/s, ` +
        `room TTL ${SIGNALING_ROOM_TTL_MS / 1000}s, ` +
        `absolute TTL ${SIGNALING_ROOM_ABSOLUTE_TTL_MS / 1000}s)`,
    );
  });

  return wss;
}

/**
 * Send a message to a single WebSocket connection.
 * Guards against sending to a closing/closed socket, which would throw.
 */
function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Relay a message from one peer to all other peers in the same room.
 *
 * The `sender` is excluded so a peer doesn't receive its own message back.
 * Only OPEN sockets receive the relay — mid-close sockets are skipped silently.
 */
function relay(room: Room, sender: WebSocket, msg: unknown): void {
  for (const peer of room.peers) {
    if (peer !== sender && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify(msg));
    }
  }
}
