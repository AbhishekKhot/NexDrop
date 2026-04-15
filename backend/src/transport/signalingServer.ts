/**
 * signalingServer.ts
 * Lightweight WebSocket signaling relay for WebRTC remote P2P.
 *
 * IMPORTANT: This server NEVER sees file bytes.
 * It only relays:
 *  - SDP offer / answer (session description for WebRTC negotiation)
 *  - ICE candidates (network path discovery)
 *
 * Security hardening:
 *  - Per-IP connection limit      (SIGNALING_MAX_CONN_PER_IP)
 *  - Per-connection message rate  (SIGNALING_MAX_MSG_PER_SEC)
 *  - Creator-only room expiry     (SIGNALING_ROOM_TTL_MS)
 *  - Room capacity: strictly 2 peers
 *
 * Fixes applied:
 *  SEC-06 — X-Forwarded-For only trusted behind a proxy (ALLOW_REMOTE_WS=true);
 *            parse the last hop to prevent IP spoofing
 *  SEC-07 — Per-IP failed-join counter; terminate after N failures in window
 *  SEC-08 — Absolute room TTL regardless of peer count
 */

import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { v4 as uuidv4 } from "uuid";
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

interface Room {
  id: string;
  peers: WebSocket[];
  /** Expires if second peer never joins */
  expiryTimer: NodeJS.Timeout | null;
  /** SEC-08: absolute TTL — room closed regardless of peer count */
  absoluteTimer: NodeJS.Timeout;
}

/** Plain-typed SDP — avoids browser-only RTCSessionDescriptionInit */
export type SessionDescription = { type: "offer" | "answer"; sdp: string };
/** Plain-typed ICE candidate — avoids browser-only RTCIceCandidateInit */
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

// ── Per-connection rate-limit state ─────────────────────────────────────────

interface ConnState {
  ip: string;
  msgCount: number;
  windowStart: number;
}

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

// ── IP-level connection tracking ─────────────────────────────────────────────

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
  if (sockets.size === 0) ipSockets.delete(ip);
}

// ── SEC-07: Failed-join tracking ─────────────────────────────────────────────

interface FailedJoinRecord {
  count: number;
  windowStart: number;
}

const failedJoins = new Map<string, FailedJoinRecord>();

/** Returns true if this IP has exceeded the failed-join limit. */
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

// Periodic cleanup of stale failed-join records
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of failedJoins) {
    if (now - rec.windowStart >= SIGNALING_FAILED_JOIN_WINDOW_MS) {
      failedJoins.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ── SEC-06: Safe client IP extraction ────────────────────────────────────────

function getClientIp(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? "unknown";

  // Only trust X-Forwarded-For when running behind a known proxy
  if (ALLOW_REMOTE_WS) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const raw = Array.isArray(xff) ? xff[0] : xff;
      // Take the last entry — the one our trusted proxy appended; cannot be spoofed
      const lastHop = raw.split(",").at(-1)?.trim();
      if (lastHop) return lastHop;
    }
  }

  return direct;
}

// ── Server factory ───────────────────────────────────────────────────────────

export function createSignalingServer(): WebSocketServer {
  const wss = new WebSocketServer({ port: SIGNALING_PORT });
  const rooms = new Map<string, Room>();

  /** Destroy a room, close all peer sockets, clean up timers */
  function destroyRoom(roomId: string, reason: string): void {
    const room = rooms.get(roomId);
    if (!room) return;
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
    // SEC-06: safe IP extraction
    const ip = getClientIp(req);

    // ── IP connection limit ────────────────────────────────────────────────
    if (!trackConnection(ip, ws)) {
      send(ws, {
        type: "error",
        message: "Too many connections from your IP. Try again later.",
      });
      ws.terminate();
      console.warn(`[Signaling] Rejected connection from ${ip} (limit reached)`);
      return;
    }

    let currentRoomId: string | null = null;
    const connState: ConnState = { ip, msgCount: 0, windowStart: Date.now() };

    ws.on("message", (raw) => {
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

      // ── Create room ──────────────────────────────────────────────────────
      if (msg.type === "create") {
        if (currentRoomId) {
          send(ws, { type: "error", message: "Already in a room" });
          return;
        }
        const roomId = uuidv4().slice(0, 8).toUpperCase();

        const expiryTimer = setTimeout(() => {
          const room = rooms.get(roomId);
          if (room && room.peers.length < 2) {
            destroyRoom(roomId, "Room expired — no peer joined in time.");
          }
        }, SIGNALING_ROOM_TTL_MS);

        // SEC-08: absolute TTL — close room even if both peers are connected
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

      // ── Join room ────────────────────────────────────────────────────────
      if (msg.type === "join" && msg.roomId) {
        if (currentRoomId) {
          send(ws, { type: "error", message: "Already in a room" });
          return;
        }

        // SEC-07: check failed-join rate before looking up the room
        if (failedJoins.get(ip) && failedJoins.get(ip)!.count >= SIGNALING_MAX_FAILED_JOINS) {
          send(ws, { type: "error", message: "Too many failed join attempts. Try again later." });
          ws.terminate();
          console.warn(`[Signaling] Failed-join limit reached for ${ip} — terminated`);
          return;
        }

        const room = rooms.get(msg.roomId);
        if (!room) {
          send(ws, { type: "error", message: `Room ${msg.roomId} not found` });
          // SEC-07: record failed join attempt
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

        // Successful join — clear failed-join record
        clearFailedJoins(ip);

        if (room.expiryTimer) {
          clearTimeout(room.expiryTimer);
          room.expiryTimer = null;
        }
        room.peers.push(ws);
        currentRoomId = room.id;
        send(ws, { type: "joined", roomId: room.id });
        relay(room, ws, { type: "peer_joined" });
        console.log(`[Signaling] Peer joined room: ${room.id} from ${ip}`);
        return;
      }

      // ── Relay SDP / ICE ──────────────────────────────────────────────────
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
        // Both peers gone — cancel absolute timer and delete room
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
