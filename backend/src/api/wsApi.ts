/**
 * wsApi.ts
 * WebSocket API — bridges the browser UI and the local agent.
 *
 * Binary streaming protocol for file send:
 *  1. JSON: { type:'send_file_start', peerId, fileName, fileSize, totalChunks, chunkSize }
 *  2. N binary frames: each is [4 bytes big-endian chunk index][raw file bytes]
 *  3. JSON: { type:'send_file_end', peerId, fileName }
 *
 * The agent:
 *  - Buffers binary chunks keyed by (peerId, fileName)
 *  - On 'send_file_end': assembles the Buffer, then calls sendFileToPeer()
 *
 * Security: only accepts connections from localhost (blocks remote connections).
 * For ngrok/mobile: the ngrok tunnel itself is the access-control boundary.
 *   Set ALLOW_REMOTE_WS=true to allow non-localhost connections.
 *
 * Fixes applied:
 *  ERR-02  — 60 s inactivity timer per in-progress stream; reset on each chunk
 */

import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import type { AgentMessage, BrowserMessage, Transfer } from "../types";
import { WS_API_PORT, DEVICE_NAME, ALLOW_REMOTE_WS, MAX_FILE_SIZE } from "../config";

const STREAM_INACTIVITY_TIMEOUT_MS = 60_000; // ERR-02

/** Tracks an in-progress binary stream from the browser */
interface InboundStream {
  peerId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunks: Map<number, Buffer>; // chunkIndex → raw bytes
  receivedCount: number;
  /** ERR-02: timer that fires if no chunk arrives within 60 s */
  inactivityTimer: NodeJS.Timeout;
}

export class WsApiServer {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  // Callbacks injected by index.ts
  onSendFile?: (peerId: string, fileName: string, fileBuffer: Buffer) => void;
  onAcceptTransfer?: (transferId: string) => void;
  onRejectTransfer?: (transferId: string) => void;
  onDiscoverPeers?: () => void;

  constructor(
    private deviceId: string,
    private maxFileSize: number = MAX_FILE_SIZE,
  ) {
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("NexDrop agent running");
    });

    this.wss = new WebSocketServer({ server: httpServer });

    this.wss.on("connection", (ws, req) => {
      const clientIp = req.socket.remoteAddress ?? "";
      const isLocalhost =
        clientIp === "127.0.0.1" ||
        clientIp === "::1" ||
        clientIp === "::ffff:127.0.0.1";

      if (!isLocalhost && !ALLOW_REMOTE_WS) {
        console.warn(
          `[WS API] Rejected connection from ${clientIp} (set ALLOW_REMOTE_WS=true for ngrok)`,
        );
        ws.close(4001, "Forbidden — only localhost connections allowed");
        return;
      }

      this.clients.add(ws);
      ws.binaryType = "nodebuffer";
      console.log(
        `[WS API] Client connected from ${clientIp} (${this.clients.size} total)`,
      );

      // Per-client stream state (keyed by "peerId:fileName")
      const streams = new Map<string, InboundStream>();

      // ── Ready event ──────────────────────────────────────────────────────
      this.sendTo(ws, {
        type: "agent_ready",
        deviceName: DEVICE_NAME,
        deviceId: this.deviceId,
        maxFileSize: this.maxFileSize,
      });

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          // ── Binary frame: file chunk ─────────────────────────────────────
          const buf = raw as Buffer;
          if (buf.length < 4) {
            console.warn("[WS API] Received too-short binary frame, ignoring");
            return;
          }

          const chunkIndex = buf.readUInt32BE(0);
          const chunkData = buf.subarray(4);

          // Find the current in-progress stream for this client
          let activeStream: InboundStream | undefined;
          for (const s of streams.values()) {
            activeStream = s;
            break;
          }

          if (!activeStream) {
            console.warn(
              `[WS API] Received binary chunk #${chunkIndex} but no active stream — ignoring`,
            );
            return;
          }

          activeStream.chunks.set(chunkIndex, chunkData);
          activeStream.receivedCount++;

          // ERR-02: reset inactivity timer on each received chunk
          clearTimeout(activeStream.inactivityTimer);
          activeStream.inactivityTimer = this._makeInactivityTimer(
            ws,
            streams,
            activeStream,
          );

          if (
            chunkIndex % 10 === 0 ||
            activeStream.receivedCount === activeStream.totalChunks
          ) {
            console.log(
              `[WS API] Stream ${activeStream.fileName}: chunk ${activeStream.receivedCount}/${activeStream.totalChunks}`,
            );
          }
          return;
        }

        // ── JSON control message ────────────────────────────────────────
        let msg: BrowserMessage;
        try {
          msg = JSON.parse((raw as Buffer).toString("utf8")) as BrowserMessage;
        } catch {
          console.warn("[WS API] Invalid JSON from browser");
          return;
        }

        this.handleMessage(msg, ws, streams);
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        // ERR-02: clear all pending inactivity timers on disconnect
        for (const stream of streams.values()) {
          clearTimeout(stream.inactivityTimer);
        }
        streams.clear();
        console.log(
          `[WS API] Client disconnected (${this.clients.size} remaining)`,
        );
      });

      ws.on("error", (err) => {
        console.error("[WS API] Socket error:", err.message);
      });
    });

    httpServer.listen(WS_API_PORT, "0.0.0.0", () => {
      console.log(`[WS API] Listening on ws://0.0.0.0:${WS_API_PORT}`);
      console.log(
        `         (set ALLOW_REMOTE_WS=true to accept ngrok/mobile connections)`,
      );
    });
  }

  /** ERR-02: build a 60 s inactivity timer for a stream */
  private _makeInactivityTimer(
    ws: WebSocket,
    streams: Map<string, InboundStream>,
    stream: InboundStream,
  ): NodeJS.Timeout {
    const key = `${stream.peerId}:${stream.fileName}`;
    return setTimeout(() => {
      console.warn(
        `[WS API] Stream timed out (no chunk for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000}s): ${stream.fileName}`,
      );
      streams.delete(key);
      this.sendTo(ws, {
        type: "error",
        message: `File stream timed out — transfer for "${stream.fileName}" was incomplete`,
        code: "STREAM_TIMEOUT",
      });
    }, STREAM_INACTIVITY_TIMEOUT_MS);
  }

  private handleMessage(
    msg: BrowserMessage,
    ws: WebSocket,
    streams: Map<string, InboundStream>,
  ): void {
    switch (msg.type) {
      case "send_file_start": {
        const key = `${msg.peerId}:${msg.fileName}`;
        if (streams.has(key)) {
          // Clear timer for old stream before replacing
          clearTimeout(streams.get(key)!.inactivityTimer);
          console.warn(
            `[WS API] Stream already in progress for ${key}, resetting`,
          );
        }

        const stream: InboundStream = {
          peerId: msg.peerId,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          totalChunks: msg.totalChunks,
          chunks: new Map(),
          receivedCount: 0,
          inactivityTimer: setTimeout(() => {}, 0), // placeholder; replaced immediately below
        };
        // ERR-02: start real inactivity timer
        stream.inactivityTimer = this._makeInactivityTimer(ws, streams, stream);
        streams.set(key, stream);

        console.log(
          `[WS API] Stream started: ${msg.fileName} → peer ${msg.peerId} (${msg.totalChunks} chunks)`,
        );
        break;
      }

      case "send_file_end": {
        const key = `${msg.peerId}:${msg.fileName}`;
        const stream = streams.get(key);
        if (!stream) {
          console.warn(`[WS API] send_file_end but no stream found for ${key}`);
          return;
        }

        // ERR-02: stream completed — clear timer
        clearTimeout(stream.inactivityTimer);

        if (stream.receivedCount !== stream.totalChunks) {
          console.warn(
            `[WS API] send_file_end but only ${stream.receivedCount}/${stream.totalChunks} chunks received`,
          );
          this.sendTo(ws, {
            type: "error",
            message: "Incomplete file stream received by agent",
          });
          streams.delete(key);
          return;
        }

        // Assemble in-order
        const parts: Buffer[] = [];
        for (let i = 0; i < stream.totalChunks; i++) {
          const chunk = stream.chunks.get(i);
          if (!chunk) {
            this.sendTo(ws, {
              type: "error",
              message: `Missing chunk ${i} in stream`,
            });
            streams.delete(key);
            return;
          }
          parts.push(chunk);
        }

        const fileBuffer = Buffer.concat(parts);
        console.log(
          `[WS API] Stream complete: ${stream.fileName} (${fileBuffer.length} bytes) — handing to TCP sender`,
        );
        streams.delete(key);

        this.onSendFile?.(stream.peerId, stream.fileName, fileBuffer);
        break;
      }

      case "accept_transfer":
        this.onAcceptTransfer?.(msg.transferId);
        break;

      case "reject_transfer":
        this.onRejectTransfer?.(msg.transferId);
        break;

      case "discover_peers":
        this.onDiscoverPeers?.();
        break;

      default:
        console.warn(
          "[WS API] Unknown message type:",
          (msg as { type: string }).type,
        );
    }
  }

  /** Broadcast an AgentMessage to all connected browser clients */
  broadcast(msg: AgentMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private sendTo(ws: WebSocket, msg: AgentMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** For use by transfer-update callbacks */
  broadcastTransfer(transfer: Transfer): void {
    this.broadcast({ type: "transfer_update", transfer });
  }
}
