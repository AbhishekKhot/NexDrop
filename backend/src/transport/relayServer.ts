import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import type { Socket } from "net";
import { randomBytes } from "crypto";
import {
  RELAY_PORT,
  RELAY_BIND_HOST,
  RELAY_ALLOWED_ORIGINS,
  RELAY_TRUST_PROXY,
  RELAY_MAX_CONN_PER_IP,
  RELAY_MAX_MSG_PER_SEC,
  RELAY_MAX_FAILED_JOINS,
  RELAY_FAILED_JOIN_WINDOW_MS,
  RELAY_ROOM_TTL_MS,
  RELAY_ROOM_ABSOLUTE_TTL_MS,
  RELAY_MAX_FILE_SIZE,
  RELAY_MAX_CONTROL_FRAME,
  RELAY_BACKPRESSURE_HIGH,
  RELAY_BACKPRESSURE_LOW,
  RELAY_CHUNK_SIZE,
  RELAY_PROTOCOL_VERSION,
} from "../config";

// Crockford Base32 minus I L O U (ambiguous). 256 % 32 === 0 → byte%32 is
// unbiased. 10 chars × 5 bits = 50 bits of entropy.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
const CODE_REGEX = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const CODE_GEN_MAX_RETRIES = 5;

// Per-chunk wire overhead: 4 (index) + 12 (IV) + 16 (GCM tag).
const CHUNK_OVERHEAD = 32;

type ErrorCode =
  | "UNSUPPORTED_VERSION"
  | "ALREADY_IN_ROOM"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "NO_PEER"
  | "FILE_TOO_LARGE"
  | "TRANSFER_ACTIVE"
  | "RATE_LIMITED"
  | "PROTOCOL_VIOLATION"
  | "INTERNAL";

// Tunable limits. Defaults come from env-backed config; tests (and bespoke
// deployments) can override any subset via the constructor.
export interface RelayLimits {
  maxConnPerIp: number;
  maxMsgPerSec: number;
  maxFailedJoins: number;
  failedJoinWindowMs: number;
  roomTtlMs: number;
  roomAbsoluteTtlMs: number;
  maxFileSize: number;
  maxControlFrame: number;
  backpressureHigh: number;
  backpressureLow: number;
}

const DEFAULT_LIMITS: RelayLimits = {
  maxConnPerIp: RELAY_MAX_CONN_PER_IP,
  maxMsgPerSec: RELAY_MAX_MSG_PER_SEC,
  maxFailedJoins: RELAY_MAX_FAILED_JOINS,
  failedJoinWindowMs: RELAY_FAILED_JOIN_WINDOW_MS,
  roomTtlMs: RELAY_ROOM_TTL_MS,
  roomAbsoluteTtlMs: RELAY_ROOM_ABSOLUTE_TTL_MS,
  maxFileSize: RELAY_MAX_FILE_SIZE,
  maxControlFrame: RELAY_MAX_CONTROL_FRAME,
  backpressureHigh: RELAY_BACKPRESSURE_HIGH,
  backpressureLow: RELAY_BACKPRESSURE_LOW,
};

interface RelayConn {
  ws: WebSocket;
  ip: string;
  helloOk: boolean;
  room: Room | null;
  // This peer's advertised receive capability. Advisory only — the relay
  // enforces the global maxFileSize regardless.
  maxFileSize: number;
  // Token bucket for control (text) frames; binary frames are governed by the
  // byte cap + backpressure, not this counter.
  tokens: number;
  lastRefill: number;
}

interface ActiveTransfer {
  transferId: string;
  fileSize: number;
  bytesForwarded: number;
  sender: RelayConn;
  receiver: RelayConn;
  paused: boolean;
}

interface Room {
  code: string;
  host: RelayConn;
  joiner: RelayConn | null;
  createdAt: number;
  idleTimer: NodeJS.Timeout | null;
  absoluteTimer: NodeJS.Timeout | null;
  activeTransfer: ActiveTransfer | null;
}

export class RelayServer {
  private wss: WebSocketServer;
  private httpServer: http.Server;
  private limits: RelayLimits;
  private rooms = new Map<string, Room>();
  private connsPerIp = new Map<string, number>();
  private failedJoins = new Map<string, { count: number; windowStart: number }>();
  private connCount = 0;

  constructor(
    port: number = RELAY_PORT,
    host: string = RELAY_BIND_HOST,
    limits: Partial<RelayLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };

    this.httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("NexDrop relay running");
    });

    // Origin allow-list on upgrade — stops arbitrary web pages from driving the
    // relay (cross-site WebSocket hijacking, CWE-352).
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: RELAY_CHUNK_SIZE + 4096,
      verifyClient: (info, cb) => {
        const origin = info.req.headers.origin;
        if (!origin || !RELAY_ALLOWED_ORIGINS.includes(origin)) {
          cb(false, 403, "Forbidden");
          return;
        }
        cb(true);
      },
    });

    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));

    this.httpServer.listen(port, host, () => {
      if (process.env.NODE_ENV === "test") return;
      const addr = this.httpServer.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[Relay] Listening on ws://${host}:${bound}`);
    });
  }

  get port(): number {
    const addr = this.httpServer.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  close(): Promise<void> {
    for (const room of this.rooms.values()) {
      if (room.idleTimer) clearTimeout(room.idleTimer);
      if (room.absoluteTimer) clearTimeout(room.absoluteTimer);
    }
    this.rooms.clear();
    return new Promise((resolve) => {
      this.wss.close(() => this.httpServer.close(() => resolve()));
    });
  }

  // ── Connection lifecycle ────────────────────────────────────────────
  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = this.getClientIp(req);
    const current = this.connsPerIp.get(ip) ?? 0;
    if (current >= this.limits.maxConnPerIp) {
      this.log(`refused: per-IP connection cap from ${ip}`);
      this.sendError(ws, "RATE_LIMITED");
      ws.close(4029, "RATE_LIMITED");
      return;
    }
    this.connsPerIp.set(ip, current + 1);
    this.connCount++;
    this.log(`client connected (${this.connCount} open)`);
    ws.binaryType = "nodebuffer";

    const conn: RelayConn = {
      ws,
      ip,
      helloOk: false,
      room: null,
      maxFileSize: this.limits.maxFileSize,
      tokens: this.limits.maxMsgPerSec,
      lastRefill: Date.now(),
    };

    ws.on("message", (raw, isBinary) => {
      if (isBinary) this.handleBinary(conn, raw as Buffer);
      else this.handleControl(conn, raw as Buffer);
    });

    ws.on("close", () => {
      const c = this.connsPerIp.get(ip) ?? 1;
      if (c <= 1) this.connsPerIp.delete(ip);
      else this.connsPerIp.set(ip, c - 1);
      this.connCount--;
      this.log(`client disconnected (${this.connCount} open)`);
      if (conn.room) this.cleanupRoom(conn.room, "peer disconnect");
    });

    ws.on("error", (err) => console.error("[Relay] socket error:", err.message));
  }

  // ── Control plane ───────────────────────────────────────────────────
  private handleControl(conn: RelayConn, raw: Buffer): void {
    if (raw.length > this.limits.maxControlFrame) {
      this.sendError(conn.ws, "PROTOCOL_VIOLATION");
      conn.ws.close();
      return;
    }
    if (!this.allowControlMessage(conn)) {
      this.sendError(conn.ws, "RATE_LIMITED");
      conn.ws.close(4029, "RATE_LIMITED");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      this.sendError(conn.ws, "PROTOCOL_VIOLATION");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      this.sendError(conn.ws, "PROTOCOL_VIOLATION");
      return;
    }
    const m = parsed as Record<string, unknown>;
    if (typeof m.t !== "string") {
      this.sendError(conn.ws, "PROTOCOL_VIOLATION");
      return;
    }

    if (!conn.helloOk) {
      if (m.t !== "hello") {
        this.sendError(conn.ws, "PROTOCOL_VIOLATION");
        conn.ws.close();
        return;
      }
      this.handleHello(conn, m);
      return;
    }

    switch (m.t) {
      case "hello":
        this.sendError(conn.ws, "PROTOCOL_VIOLATION");
        break;
      case "create":
        this.handleCreate(conn, m);
        break;
      case "join":
        this.handleJoin(conn, m);
        break;
      case "leave":
        if (conn.room) this.cleanupRoom(conn.room, "leave");
        break;
      case "transfer_begin":
        this.handleTransferBegin(conn, m);
        break;
      case "transfer_end":
        this.handleTransferEnd(conn);
        break;
      // Anything else is a peer-relayed message (ecdh_hello, offer_transfer,
      // transfer_decision, file_end, future x_*): forward verbatim.
      default:
        this.forwardToPeer(conn, raw);
        break;
    }
  }

  private handleHello(conn: RelayConn, m: Record<string, unknown>): void {
    if (m.v !== RELAY_PROTOCOL_VERSION) {
      this.sendError(conn.ws, "UNSUPPORTED_VERSION");
      conn.ws.close();
      return;
    }
    conn.helloOk = true;
    this.sendJson(conn.ws, {
      t: "welcome",
      v: RELAY_PROTOCOL_VERSION,
      maxFileSize: this.limits.maxFileSize,
    });
  }

  private handleCreate(conn: RelayConn, m: Record<string, unknown>): void {
    if (conn.room) {
      this.sendError(conn.ws, "ALREADY_IN_ROOM");
      return;
    }
    const code = this.generateUniqueCode();
    if (!code) {
      this.sendError(conn.ws, "INTERNAL");
      return;
    }
    conn.maxFileSize = this.parseMaxFileSize(m.maxFileSize);
    const room: Room = {
      code,
      host: conn,
      joiner: null,
      createdAt: Date.now(),
      idleTimer: setTimeout(
        () => this.cleanupRoom(room, "idle TTL"),
        this.limits.roomTtlMs,
      ),
      absoluteTimer: null,
      activeTransfer: null,
    };
    this.rooms.set(code, room);
    conn.room = room;
    this.sendJson(conn.ws, { t: "created", code });
    this.log(`room created (${this.rooms.size} active)`);
  }

  private handleJoin(conn: RelayConn, m: Record<string, unknown>): void {
    if (conn.room) {
      this.sendError(conn.ws, "ALREADY_IN_ROOM");
      return;
    }
    if (this.isJoinRateLimited(conn.ip)) {
      this.sendError(conn.ws, "RATE_LIMITED");
      return;
    }
    // Generic ROOM_NOT_FOUND for both malformed and missing — do not reveal
    // which (brute-force defence, alongside the failed-join rate limit).
    if (typeof m.code !== "string" || !CODE_REGEX.test(m.code)) {
      this.recordFailedJoin(conn.ip);
      this.sendError(conn.ws, "ROOM_NOT_FOUND");
      return;
    }
    const room = this.rooms.get(m.code);
    if (!room) {
      this.recordFailedJoin(conn.ip);
      this.sendError(conn.ws, "ROOM_NOT_FOUND");
      return;
    }
    if (room.joiner) {
      this.sendError(conn.ws, "ROOM_FULL");
      return;
    }

    conn.maxFileSize = this.parseMaxFileSize(m.maxFileSize);
    room.joiner = conn;
    conn.room = room;
    if (room.idleTimer) {
      clearTimeout(room.idleTimer);
      room.idleTimer = null;
    }
    room.absoluteTimer = setTimeout(
      () => this.cleanupRoom(room, "absolute TTL"),
      this.limits.roomAbsoluteTtlMs,
    );

    this.sendJson(conn.ws, {
      t: "joined",
      code: room.code,
      peerMaxFileSize: room.host.maxFileSize,
    });
    this.sendJson(room.host.ws, {
      t: "peer_joined",
      peerMaxFileSize: conn.maxFileSize,
    });
    this.log(`peer paired (${this.rooms.size} active)`);
  }

  private handleTransferBegin(
    conn: RelayConn,
    m: Record<string, unknown>,
  ): void {
    const room = conn.room;
    if (!room || !room.joiner) {
      this.sendError(conn.ws, "NO_PEER");
      return;
    }
    if (room.activeTransfer) {
      this.sendError(conn.ws, "TRANSFER_ACTIVE");
      return;
    }
    if (
      typeof m.transferId !== "string" ||
      m.transferId.length === 0 ||
      m.transferId.length > 128
    ) {
      this.sendError(conn.ws, "PROTOCOL_VIOLATION");
      return;
    }
    if (
      typeof m.fileSize !== "number" ||
      !Number.isInteger(m.fileSize) ||
      m.fileSize < 1
    ) {
      this.sendError(conn.ws, "PROTOCOL_VIOLATION");
      return;
    }
    if (m.fileSize > this.limits.maxFileSize) {
      this.sendError(conn.ws, "FILE_TOO_LARGE");
      return;
    }
    const totalChunks =
      typeof m.totalChunks === "number" && Number.isInteger(m.totalChunks)
        ? m.totalChunks
        : Math.ceil(m.fileSize / RELAY_CHUNK_SIZE);

    const receiver = this.peerOf(room, conn);
    if (!receiver) {
      this.sendError(conn.ws, "NO_PEER");
      return;
    }

    room.activeTransfer = {
      transferId: m.transferId,
      fileSize: m.fileSize,
      bytesForwarded: 0,
      sender: conn,
      receiver,
      paused: false,
    };
    this.sendJson(receiver.ws, {
      t: "transfer_begin",
      transferId: m.transferId,
      fileSize: m.fileSize,
      totalChunks,
    });
    this.log(`transfer begin: ${m.fileSize} bytes, ${totalChunks} chunks`);
  }

  private handleTransferEnd(conn: RelayConn): void {
    const room = conn.room;
    const t = room?.activeTransfer;
    if (!room || !t || conn !== t.sender) {
      this.sendError(conn.ws, "PROTOCOL_VIOLATION");
      return;
    }
    if (t.paused) this.rawSocket(t.sender.ws)?.resume();
    room.activeTransfer = null;
    if (t.receiver.ws.readyState === WebSocket.OPEN) {
      this.sendJson(t.receiver.ws, { t: "transfer_end", transferId: t.transferId });
    }
    this.log(`transfer end (${t.bytesForwarded} bytes forwarded)`);
  }

  // ── Data plane ──────────────────────────────────────────────────────
  private handleBinary(conn: RelayConn, data: Buffer): void {
    const room = conn.room;
    const t = room?.activeTransfer;
    // Binary frames are only legal from the active sender during a transfer.
    if (!room || !t || conn !== t.sender) {
      this.sendError(conn.ws, "PROTOCOL_VIOLATION");
      conn.ws.close();
      return;
    }

    t.bytesForwarded += data.length;
    const numChunks = Math.ceil(t.fileSize / RELAY_CHUNK_SIZE);
    const maxWireBytes = t.fileSize + numChunks * CHUNK_OVERHEAD + 1024;
    if (t.bytesForwarded > maxWireBytes) {
      // A sender lying about fileSize cannot exhaust relay bandwidth (CWE-770).
      this.sendError(conn.ws, "FILE_TOO_LARGE");
      this.cleanupRoom(room, "oversize stream");
      return;
    }

    const dest = t.receiver.ws;
    if (dest.readyState !== WebSocket.OPEN) {
      this.sendError(conn.ws, "NO_PEER");
      this.cleanupRoom(room, "receiver gone mid-stream");
      return;
    }
    dest.send(data);
    this.applyBackpressure(t);
  }

  // ws does not auto-throttle: when the destination's send buffer grows past
  // HIGH, pause the source's TCP socket so a slow receiver cannot make the relay
  // accumulate unbounded memory. Resume below LOW.
  private applyBackpressure(t: ActiveTransfer): void {
    if (t.paused) return;
    const dest = t.receiver.ws;
    if (dest.bufferedAmount <= this.limits.backpressureHigh) return;
    const srcSock = this.rawSocket(t.sender.ws);
    if (!srcSock) return;

    t.paused = true;
    srcSock.pause();
    const check = (): void => {
      if (
        dest.readyState !== WebSocket.OPEN ||
        t.sender.ws.readyState !== WebSocket.OPEN
      ) {
        t.paused = false;
        srcSock.resume();
        return;
      }
      if (dest.bufferedAmount <= this.limits.backpressureLow) {
        t.paused = false;
        srcSock.resume();
      } else {
        setTimeout(check, 20);
      }
    };
    setTimeout(check, 20);
  }

  private forwardToPeer(conn: RelayConn, raw: Buffer): void {
    const room = conn.room;
    if (!room) {
      this.sendError(conn.ws, "NO_PEER");
      return;
    }
    const peer = this.peerOf(room, conn);
    if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
      this.sendError(conn.ws, "NO_PEER");
      return;
    }
    // Forward as text — the original was a text control frame and the peer
    // parses it as JSON.
    peer.ws.send(raw.toString("utf8"));
  }

  // ── Room teardown ───────────────────────────────────────────────────
  private cleanupRoom(room: Room, reason: string): void {
    if (!this.rooms.has(room.code)) return; // already torn down
    if (room.idleTimer) clearTimeout(room.idleTimer);
    if (room.absoluteTimer) clearTimeout(room.absoluteTimer);
    if (room.activeTransfer?.paused) {
      this.rawSocket(room.activeTransfer.sender.ws)?.resume();
    }
    const members = [room.host, room.joiner].filter(
      (c): c is RelayConn => c !== null,
    );
    for (const member of members) {
      member.room = null;
      if (member.ws.readyState === WebSocket.OPEN) {
        this.sendJson(member.ws, { t: "peer_left" });
      }
    }
    this.rooms.delete(room.code);
    this.log(`room closed: ${reason} (${this.rooms.size} active)`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────
  private peerOf(room: Room, conn: RelayConn): RelayConn | null {
    if (conn === room.host) return room.joiner;
    if (conn === room.joiner) return room.host;
    return null;
  }

  private rawSocket(ws: WebSocket): Socket | undefined {
    return (ws as unknown as { _socket?: Socket })._socket;
  }

  private generateUniqueCode(): string | null {
    for (let attempt = 0; attempt < CODE_GEN_MAX_RETRIES; attempt++) {
      const bytes = randomBytes(CODE_LENGTH);
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[bytes[i] % 32];
      }
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  private parseMaxFileSize(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return this.limits.maxFileSize;
    }
    return Math.min(Math.floor(value), this.limits.maxFileSize);
  }

  private allowControlMessage(conn: RelayConn): boolean {
    const now = Date.now();
    const elapsed = (now - conn.lastRefill) / 1000;
    conn.tokens = Math.min(
      this.limits.maxMsgPerSec,
      conn.tokens + elapsed * this.limits.maxMsgPerSec,
    );
    conn.lastRefill = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  private isJoinRateLimited(ip: string): boolean {
    const entry = this.failedJoins.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > this.limits.failedJoinWindowMs) {
      this.failedJoins.delete(ip);
      return false;
    }
    return entry.count >= this.limits.maxFailedJoins;
  }

  private recordFailedJoin(ip: string): void {
    const now = Date.now();
    const entry = this.failedJoins.get(ip);
    if (!entry || now - entry.windowStart > this.limits.failedJoinWindowMs) {
      this.failedJoins.set(ip, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
  }

  private getClientIp(req: http.IncomingMessage): string {
    if (RELAY_TRUST_PROXY) {
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff.length > 0) {
        return xff.split(",")[0].trim();
      }
    }
    return req.socket.remoteAddress ?? "";
  }

  private sendJson(ws: WebSocket, obj: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  private sendError(ws: WebSocket, code: ErrorCode): void {
    this.sendJson(ws, { t: "error", code });
  }

  // Operational logging only. Never logs share codes (bearer secrets), file
  // names, or payloads — see docs/RELAY_PROTOCOL.md §12.
  log(msg: string): void {
    if (process.env.NODE_ENV === "test") return;
    console.log(`[Relay] ${msg}`);
  }
}

export function createRelayServer(): RelayServer {
  return new RelayServer();
}
