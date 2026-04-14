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
 *  - Per-IP connection limit   (SIGNALING_MAX_CONN_PER_IP)
 *  - Per-connection message rate limit (SIGNALING_MAX_MSG_PER_SEC)
 *  - Creator-only room expiry  (SIGNALING_ROOM_TTL_MS)
 *  - Room capacity: strictly 2 peers
 */

import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { v4 as uuidv4 } from "uuid";
import {
  SIGNALING_PORT,
  SIGNALING_MAX_CONN_PER_IP,
  SIGNALING_MAX_MSG_PER_SEC,
  SIGNALING_ROOM_TTL_MS,
} from "../config";

interface Room {
  id: string;
  peers: WebSocket[];
  expiryTimer: NodeJS.Timeout | null;
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
  /** Messages counted in the current 1-second window */
  msgCount: number;
  /** Timestamp (ms) when the current window started */
  windowStart: number;
}

/** Returns true if the message is allowed; false if rate limit exceeded. */
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

// ── Server factory ───────────────────────────────────────────────────────────

export function createSignalingServer(): WebSocketServer {
  const wss = new WebSocketServer({ port: SIGNALING_PORT });
  const rooms = new Map<string, Room>();

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)
        ?.split(",")[0]
        .trim() ??
      req.socket.remoteAddress ??
      "unknown";

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
      // ── Per-connection rate limit ────────────────────────────────────────
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

        // Expire the room if no second peer joins in time
        const expiryTimer = setTimeout(() => {
          const room = rooms.get(roomId);
          if (room && room.peers.length < 2) {
            send(ws, {
              type: "error",
              message: "Room expired — no peer joined in time.",
            });
            ws.close();
            rooms.delete(roomId);
            console.log(`[Signaling] Room expired (no join): ${roomId}`);
          }
        }, SIGNALING_ROOM_TTL_MS);

        const room: Room = { id: roomId, peers: [ws], expiryTimer };
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
        const room = rooms.get(msg.roomId);
        if (!room) {
          send(ws, { type: "error", message: `Room ${msg.roomId} not found` });
          return;
        }
        if (room.peers.length >= 2) {
          send(ws, { type: "error", message: "Room is full" });
          return;
        }
        // Cancel expiry — the second peer joined in time
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
        `room TTL ${SIGNALING_ROOM_TTL_MS / 1000}s)`,
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
