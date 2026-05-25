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

// Crockford-style base32 excluding 0/O/1/I/L for unambiguous human entry.
// 32 symbols is a power of two so `byte & 0x1f` is uniformly distributed —
// no modulo bias, no rejection sampling needed.
const SHARE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
// 10 chars × 5 bits = 50 bits of entropy ≈ 1.1×10^15 combinations.
// Previous version used uuidv4().slice(0,8) which only emitted hex digits
// for ~4.3×10^9 — an order of magnitude smaller than the comments claimed.
const SHARE_CODE_LENGTH = 10;

function generateShareCode(): string {
  // uses CSPRNG; do not switch to Math.random
  const bytes = crypto.randomBytes(SHARE_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    out += SHARE_CODE_ALPHABET[bytes[i] & 0x1f];
  }
  return out;
}

/**
 * Two timers guard each room's lifetime:
 *  expiryTimer   — cancelled when the second peer joins; fires if creator
 *                  waits too long alone.
 *  absoluteTimer — fires unconditionally after SIGNALING_ROOM_ABSOLUTE_TTL_MS
 *                  even if both peers are connected, so the signaling server
 *                  doesn't function as a persistent covert relay channel.
 */
interface Room {
  id: string;
  peers: WebSocket[];
  expiryTimer: NodeJS.Timeout | null;
  absoluteTimer: NodeJS.Timeout;
}

export type SessionDescription = { type: "offer" | "answer"; sdp: string };
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

interface ConnState {
  ip: string;
  msgCount: number;
  windowStart: number;
}

// Mutates state in place to avoid allocations on the hot path.
function checkRateLimit(state: ConnState): boolean {
  const now = Date.now();
  if (now - state.windowStart >= 1000) {
    state.msgCount = 1;
    state.windowStart = now;
    return true;
  }
  state.msgCount++;
  return state.msgCount <= SIGNALING_MAX_MSG_PER_SEC;
}

// Set<WebSocket> (not a counter) so untrackConnection() removes the exact
// socket and the count can't drift if 'close' and 'error' both fire.
const ipSockets = new Map<string, Set<WebSocket>>();

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

function untrackConnection(ip: string, ws: WebSocket): void {
  const sockets = ipSockets.get(ip);
  if (!sockets) return;
  sockets.delete(ws);
  // Delete entry at zero to avoid unbounded Map growth over long uptime
  if (sockets.size === 0) ipSockets.delete(ip);
}

interface FailedJoinRecord {
  count: number;
  windowStart: number;
}

const failedJoins = new Map<string, FailedJoinRecord>();

// Window resets on each call once the previous window has expired, so a
// legitimate user who mistyped a code can try again after a minute.
function recordFailedJoin(ip: string): boolean {
  const now = Date.now();
  let rec = failedJoins.get(ip);

  if (!rec || now - rec.windowStart >= SIGNALING_FAILED_JOIN_WINDOW_MS) {
    rec = { count: 1, windowStart: now };
  } else {
    rec.count++;
  }
  failedJoins.set(ip, rec);

  return rec.count > SIGNALING_MAX_FAILED_JOINS;
}

function clearFailedJoins(ip: string): void {
  failedJoins.delete(ip);
}

// Periodic cleanup so IPs that fail once and go away don't accumulate forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of failedJoins) {
    if (now - rec.windowStart >= SIGNALING_FAILED_JOIN_WINDOW_MS) {
      failedJoins.delete(ip);
    }
  }
}, 5 * 60 * 1000);

/**
 * Extract the real client IP. XFF is trivially spoofable by the client, so we
 * only trust it when ALLOW_REMOTE_WS=true (signals a trusted reverse proxy in
 * front). Take the LAST entry — the first is client-controlled; the last is
 * appended by the trusted proxy and cannot be spoofed.
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

export function createSignalingServer(): WebSocketServer {
  const wss = new WebSocketServer({ port: SIGNALING_PORT });
  const rooms = new Map<string, Room>();

  // Centralised to prevent the three callers (expiry timer, absolute timer,
  // ws.on('close') when room becomes empty) from duplicating cleanup logic
  // and risking leaked timer handles.
  function destroyRoom(roomId: string, reason: string): void {
    const room = rooms.get(roomId);
    if (!room) return;
    // Clear both timers before sending — avoids a second destroyRoom() call
    // from a timer firing while we're already tearing down.
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
    const ip = getClientIp(req);

    if (!trackConnection(ip, ws)) {
      send(ws, {
        type: "error",
        message: "Too many connections from your IP. Try again later.",
      });
      // terminate() (not close()) sends no FIN — faster for abusers
      ws.terminate();
      console.warn(`[Signaling] Rejected connection from ${ip} (limit reached)`);
      return;
    }

    let currentRoomId: string | null = null;
    const connState: ConnState = { ip, msgCount: 0, windowStart: Date.now() };

    ws.on("message", (raw) => {
      // Applied before any parsing so even malformed JSON counts toward the limit
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

      if (msg.type === "create") {
        if (currentRoomId) {
          send(ws, { type: "error", message: "Already in a room" });
          return;
        }

        // Collisions in a 2^50 space are astronomically unlikely, but a
        // check-and-regenerate loop bounds the worst case deterministically
        // and prevents silent room overwrite.
        let roomId = generateShareCode();
        for (let attempt = 0; rooms.has(roomId) && attempt < 5; attempt++) {
          roomId = generateShareCode();
        }
        if (rooms.has(roomId)) {
          // 5 collisions in a row means RNG failure or catastrophic live-room count — refuse rather than overwrite
          send(ws, {
            type: "error",
            message: "Unable to allocate a unique room ID. Try again.",
          });
          return;
        }

        const expiryTimer = setTimeout(() => {
          const room = rooms.get(roomId);
          if (room && room.peers.length < 2) {
            destroyRoom(roomId, "Room expired — no peer joined in time.");
          }
        }, SIGNALING_ROOM_TTL_MS);

        // Absolute TTL even if both peers stay connected — transfers should
        // complete within 30 min; any room still open after that is abandoned
        // or misused.
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

      if (msg.type === "join" && msg.roomId) {
        if (currentRoomId) {
          send(ws, { type: "error", message: "Already in a room" });
          return;
        }

        // Pre-flight before room lookup so a previously-blocked IP can't probe
        // whether a room exists.
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

        if (!room) {
          send(ws, { type: "error", message: `Room ${msg.roomId} not found` });
          if (recordFailedJoin(ip)) {
            console.warn(`[Signaling] ${ip} exceeded failed-join limit`);
            ws.terminate();
          }
          return;
        }

        if (room.peers.length >= 2) {
          send(ws, { type: "error", message: "Room is full" });
          if (recordFailedJoin(ip)) {
            console.warn(`[Signaling] ${ip} exceeded failed-join limit`);
            ws.terminate();
          }
          return;
        }

        // Reset counter on success so a few typos don't accidentally block
        // this IP after a successful connection.
        clearFailedJoins(ip);

        if (room.expiryTimer) {
          clearTimeout(room.expiryTimer);
          room.expiryTimer = null;
        }

        room.peers.push(ws);
        currentRoomId = room.id;
        send(ws, { type: "joined", roomId: room.id });
        // Notify the first peer so it can initiate the WebRTC offer
        relay(room, ws, { type: "peer_joined" });
        console.log(`[Signaling] Peer joined room: ${room.id} from ${ip}`);
        return;
      }

      // Forwarded verbatim — server doesn't inspect/modify since doing so
      // could break the WebRTC handshake.
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

      if (room.expiryTimer) {
        clearTimeout(room.expiryTimer);
        room.expiryTimer = null;
      }

      relay(room, ws, { type: "peer_left" });
      room.peers = room.peers.filter((p) => p !== ws);

      if (room.peers.length === 0) {
        // Cancel absolute TTL so it doesn't fire destroyRoom() on an already-deleted room
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

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function relay(room: Room, sender: WebSocket, msg: unknown): void {
  for (const peer of room.peers) {
    if (peer !== sender && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify(msg));
    }
  }
}
