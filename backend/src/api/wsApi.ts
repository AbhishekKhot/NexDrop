import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import type { AgentMessage, BrowserMessage, Transfer } from "../types";
import {
  WS_API_PORT,
  DEVICE_NAME,
  ALLOW_REMOTE_WS,
  MAX_FILE_SIZE,
  WS_ALLOWED_ORIGIN,
} from "../config";


const ALLOWED_ORIGINS = new Set(
  WS_ALLOWED_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
);

const STREAM_INACTIVITY_TIMEOUT_MS = 60_000;

interface InboundStream {
  peerId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunks: Map<number, Buffer>;
  receivedCount: number;
  inactivityTimer: NodeJS.Timeout;
}

export class WsApiServer {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

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

    // Validate Origin during WS upgrade — without this any page the user visits
    // could open a WS to ws://localhost:4001 and drive the local agent.
    // Non-browser clients can forge Origin; the localhost-only check below covers that.
    this.wss = new WebSocketServer({
      server: httpServer,
      verifyClient: (info, cb) => {
        const origin = info.req.headers.origin;
        if (!origin || !ALLOWED_ORIGINS.has(origin)) {
          console.warn(
            `[WS API] Rejected WS upgrade: disallowed Origin "${origin ?? "<none>"}"`,
          );
          cb(false, 403, "Forbidden");
          return;
        }
        cb(true);
      },
    });

    this.wss.on("connection", (ws, req) => {
      const clientIp = req.socket.remoteAddress ?? "";

      // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1) so the check works regardless
      // of whether Node listens on IPv4 or IPv6.
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
      // 'nodebuffer' so binary frames arrive as Buffer; default 'blob' is browser-only
      ws.binaryType = "nodebuffer";
      console.log(
        `[WS API] Client connected from ${clientIp} (${this.clients.size} total)`,
      );

      const streams = new Map<string, InboundStream>();

      this.sendTo(ws, {
        type: "agent_ready",
        deviceName: DEVICE_NAME,
        deviceId: this.deviceId,
        maxFileSize: this.maxFileSize,
      });

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          const buf = raw as Buffer;

          if (buf.length < 4) {
            console.warn("[WS API] Received too-short binary frame, ignoring");
            return;
          }

          // First 4 bytes: big-endian chunk index (matches encoding in agentSocket.ts)
          const chunkIndex = buf.readUInt32BE(0);
          const chunkData = buf.subarray(4);

          // Only one stream can be active per client at a time (enforced by serial
          // queue on the browser side). Binary frames don't carry peerId/fileName,
          // so we take the first registered stream.
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

          // Reset inactivity timer on every chunk — each chunk proves the browser
          // is still alive and actively uploading.
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
        // Clear pending inactivity timers on disconnect — without this they would
        // fire after close, try to send to a closed socket, and generate spurious errors.
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

  // Returns a fresh handle rather than mutating a field — the timer is replaced
  // on every chunk; returning a new handle avoids a race where the old handle
  // fires between clearTimeout() and the new setTimeout() assignment.
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

        // Replace any previous stream for this key — handles a browser re-submit
        // after an interrupted upload that never called send_file_end.
        if (streams.has(key)) {
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
          inactivityTimer: setTimeout(() => {}, 0),
        };
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

        // Iterate 0..totalChunks-1 explicitly rather than iterating the Map
        // to catch any gap in chunk indices.
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

  broadcast(msg: AgentMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      // Skip mid-close sockets to avoid ws.send() throwing
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

  broadcastTransfer(transfer: Transfer): void {
    this.broadcast({ type: "transfer_update", transfer });
  }
}
