/**
 * wsApi.ts
 * WebSocket API server — bridges the browser UI and the local NexDrop agent.
 *
 * This is the only interface between the React frontend and the Node.js backend.
 * It runs on localhost (WS_API_PORT, default 4001) and handles two kinds of traffic:
 *
 *  JSON control messages  — typed AgentMessage / BrowserMessage objects.
 *  Binary frames          — raw file chunks the browser streams for a pending send.
 *
 * Binary file streaming protocol (browser → agent):
 *  1. JSON:   { type:'send_file_start', peerId, fileName, fileSize, totalChunks, chunkSize }
 *  2. Binary: N frames, each = [4-byte big-endian chunk index][raw chunk bytes]
 *  3. JSON:   { type:'send_file_end', peerId, fileName }
 *
 * On receiving send_file_end the agent assembles the Buffer from the chunks
 * map, then calls onSendFile() which triggers sendFileToPeer() over TCP.
 *
 * Security model:
 *  By default (ALLOW_REMOTE_WS=false) only connections from 127.0.0.1 / ::1 are
 *  accepted, preventing other machines on the network from controlling the agent.
 *  Set ALLOW_REMOTE_WS=true when tunnelling via ngrok or a reverse proxy.
 *
 * Fixes applied:
 *  ERR-02 — 60 s inactivity timer per in-progress stream; reset on every chunk.
 *            Without this, a browser tab that starts a file upload and then crashes
 *            would leave the agent holding an incomplete InboundStream forever,
 *            leaking memory and blocking future sends to the same peer.
 */

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

/**
 * SEC-10: parse WS_ALLOWED_ORIGIN once at module load.
 *
 * Supports a comma-separated list so operators can authorise multiple origins
 * (e.g. dev server on :5173 plus a Caddy-fronted prod origin) without code
 * changes. Each entry is trimmed; empty entries are dropped.
 */
const ALLOWED_ORIGINS = new Set(
  WS_ALLOWED_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0),
);

/** How long (ms) an in-progress stream may be idle before being torn down — ERR-02 */
const STREAM_INACTIVITY_TIMEOUT_MS = 60_000;

/**
 * Tracks one in-progress binary file upload from the browser.
 *
 * A stream is opened by send_file_start and closed by send_file_end (or the
 * inactivity timer if the browser never completes).  Only one active stream
 * per (peerId, fileName) key is allowed — a duplicate send_file_start resets
 * the existing stream rather than creating a second one.
 *
 * chunks is a Map<chunkIndex, Buffer> rather than an array because chunks may
 * arrive slightly out of order (unlikely over loopback, but defensively handled).
 * The Map allows O(1) insertion by index and gap detection at send_file_end time.
 */
interface InboundStream {
  peerId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunks: Map<number, Buffer>;  // chunk index → raw bytes
  receivedCount: number;        // how many chunks have arrived
  /** ERR-02: fires if no chunk arrives within STREAM_INACTIVITY_TIMEOUT_MS */
  inactivityTimer: NodeJS.Timeout;
}

export class WsApiServer {
  private wss: WebSocketServer;
  /** All currently connected browser clients — used for broadcast() */
  private clients: Set<WebSocket> = new Set();

  /**
   * Callbacks injected by index.ts after construction.
   * Optional chaining (?.) means a missing callback is silently ignored,
   * which avoids requiring index.ts to set them in a specific order.
   */
  onSendFile?: (peerId: string, fileName: string, fileBuffer: Buffer) => void;
  onAcceptTransfer?: (transferId: string) => void;
  onRejectTransfer?: (transferId: string) => void;
  onDiscoverPeers?: () => void;

  /**
   * @param deviceId    Stable UUID for this agent (from MdnsService.deviceId).
   *                    Included in the agent_ready message so the browser can
   *                    distinguish between multiple agent instances.
   * @param maxFileSize Maximum file size the agent will accept.  Sent to the
   *                    browser in agent_ready so frontend validation uses the
   *                    same limit as the backend (SEC-03).
   */
  constructor(
    private deviceId: string,
    private maxFileSize: number = MAX_FILE_SIZE,
  ) {
    // Wrap WebSocketServer in an http.Server so we can also serve a plain HTTP
    // response on the same port — useful for health checks and confirming the
    // agent is running from a browser tab.
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("NexDrop agent running");
    });

    /**
     * SEC-10: Validate the Origin header during the WebSocket upgrade.
     *
     * Browsers always send Origin on WebSocket handshakes.  Without this check
     * any web page the user visits could open a WS to ws://localhost:4001 and
     * drive the local agent (initiate file sends, accept incoming transfers,
     * read the peer list).  Validating against an allow-list closes that
     * cross-origin attack surface entirely.
     *
     * verifyClient runs DURING the HTTP upgrade — rejected handshakes get an
     * HTTP 403 and never enter the application-level connection handler.
     *
     * Non-browser clients can forge Origin freely.  The localhost-only check
     * in the connection handler covers that side of the threat model.
     */
    this.wss = new WebSocketServer({
      server: httpServer,
      verifyClient: (info, cb) => {
        const origin = info.req.headers.origin;
        if (!origin || !ALLOWED_ORIGINS.has(origin)) {
          console.warn(
            `[WS API] Rejected WS upgrade: disallowed Origin "${origin ?? "<none>"}"`,
          );
          // Generic error string; specific Origin value is logged server-side
          cb(false, 403, "Forbidden");
          return;
        }
        cb(true);
      },
    });

    this.wss.on("connection", (ws, req) => {
      const clientIp = req.socket.remoteAddress ?? "";

      // Normalise IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) so the
      // localhost check works regardless of whether Node listens on IPv4 or IPv6.
      const isLocalhost =
        clientIp === "127.0.0.1" ||
        clientIp === "::1" ||
        clientIp === "::ffff:127.0.0.1";

      // Reject non-localhost connections unless explicitly allowed.
      // This prevents other devices on the LAN from driving the agent's UI
      // (accepting/rejecting transfers, sending files to arbitrary peers, etc.).
      if (!isLocalhost && !ALLOW_REMOTE_WS) {
        console.warn(
          `[WS API] Rejected connection from ${clientIp} (set ALLOW_REMOTE_WS=true for ngrok)`,
        );
        ws.close(4001, "Forbidden — only localhost connections allowed");
        return;
      }

      this.clients.add(ws);
      // Set binaryType to 'nodebuffer' so binary frames arrive as Buffer objects
      // (the default 'blob' type is browser-only and not available in Node)
      ws.binaryType = "nodebuffer";
      console.log(
        `[WS API] Client connected from ${clientIp} (${this.clients.size} total)`,
      );

      // Per-client stream state — keyed by "peerId:fileName" composite key.
      // Using a Map rather than a single field allows future support for
      // multiple concurrent uploads from the same browser tab.
      const streams = new Map<string, InboundStream>();

      // Send agent_ready immediately on connect so the browser knows the agent
      // is live and gets the maxFileSize limit for its own validation.
      this.sendTo(ws, {
        type: "agent_ready",
        deviceName: DEVICE_NAME,
        deviceId: this.deviceId,
        maxFileSize: this.maxFileSize,
      });

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          // ── Binary frame: a file chunk from the browser ──────────────────
          const buf = raw as Buffer;

          // Minimum valid binary frame is 4-byte index + at least 1 byte of data
          if (buf.length < 4) {
            console.warn("[WS API] Received too-short binary frame, ignoring");
            return;
          }

          // First 4 bytes: big-endian chunk index (matches the encoding in agentSocket.ts)
          const chunkIndex = buf.readUInt32BE(0);
          const chunkData = buf.subarray(4);

          // Find the active stream for this client.
          // In the current protocol only one stream can be active per client at
          // a time (enforced by LOAD-02 serial queue on the browser side).
          // We take the first entry rather than keying by index because the
          // binary frame doesn't carry a peerId/fileName header.
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

          // ERR-02: reset the inactivity timer on every received chunk.
          // Each chunk proves the browser is still alive and actively uploading.
          clearTimeout(activeStream.inactivityTimer);
          activeStream.inactivityTimer = this._makeInactivityTimer(
            ws,
            streams,
            activeStream,
          );

          // Log progress every 10 chunks (or on the last chunk) to avoid
          // flooding the console for large files
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

        // ── JSON control message ──────────────────────────────────────────
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
        // ERR-02: clear all pending inactivity timers when the browser disconnects.
        // Without this, timers would fire after close, try to send to a closed
        // socket, and generate spurious errors.
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

  /**
   * Build a 60-second inactivity timer for a stream — ERR-02.
   *
   * Why return a new NodeJS.Timeout rather than mutating a field?
   * The timer is replaced on every chunk arrival (cleared then recreated).
   * Returning a fresh handle avoids a race where the old handle fires between
   * clearTimeout() and the new setTimeout() assignment.
   *
   * When the timer fires:
   *  1. The stream is removed from the Map so memory is freed.
   *  2. An error toast is sent to the browser explaining the timeout.
   *  3. The browser can retry the upload — the agent is not in a broken state.
   */
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

  /**
   * Handle a parsed JSON control message from the browser.
   *
   * Split into its own method (rather than inline in the ws.on('message') handler)
   * so the binary vs JSON dispatch in the outer handler stays readable.
   */
  private handleMessage(
    msg: BrowserMessage,
    ws: WebSocket,
    streams: Map<string, InboundStream>,
  ): void {
    switch (msg.type) {
      // ── send_file_start: browser is about to stream file chunks ────────────
      case "send_file_start": {
        const key = `${msg.peerId}:${msg.fileName}`;

        // If a previous stream for the same key exists, clear its timer and
        // replace it.  This handles the case where a browser re-submits a file
        // after a previous upload was interrupted without calling send_file_end.
        if (streams.has(key)) {
          clearTimeout(streams.get(key)!.inactivityTimer);
          console.warn(
            `[WS API] Stream already in progress for ${key}, resetting`,
          );
        }

        // Use a placeholder timer immediately replaced below — avoids
        // TypeScript complaining about a missing required field while still
        // ensuring the field is always set before the stream is used.
        const stream: InboundStream = {
          peerId: msg.peerId,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          totalChunks: msg.totalChunks,
          chunks: new Map(),
          receivedCount: 0,
          inactivityTimer: setTimeout(() => {}, 0), // replaced immediately
        };
        // ERR-02: start the real inactivity timer now that the stream is registered
        stream.inactivityTimer = this._makeInactivityTimer(ws, streams, stream);
        streams.set(key, stream);

        console.log(
          `[WS API] Stream started: ${msg.fileName} → peer ${msg.peerId} (${msg.totalChunks} chunks)`,
        );
        break;
      }

      // ── send_file_end: all chunks have been sent — assemble and forward ─────
      case "send_file_end": {
        const key = `${msg.peerId}:${msg.fileName}`;
        const stream = streams.get(key);
        if (!stream) {
          console.warn(`[WS API] send_file_end but no stream found for ${key}`);
          return;
        }

        // ERR-02: stream is complete — cancel the inactivity timer
        clearTimeout(stream.inactivityTimer);

        // Validate chunk count before assembling.
        // A mismatch means some chunks were lost (shouldn't happen over loopback,
        // but defensively checked).
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

        // Assemble chunks in index order.
        // We iterate 0..totalChunks-1 explicitly rather than iterating the Map
        // to catch any gap in chunk indices (a missing chunk would be undefined).
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

        // Hand off to the TCP send pipeline — this triggers the full ECDH +
        // AES-256-GCM + chunk streaming flow in tcpClient.ts
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
        // Triggers an immediate mDNS peer list snapshot broadcast to this client
        this.onDiscoverPeers?.();
        break;

      default:
        console.warn(
          "[WS API] Unknown message type:",
          (msg as { type: string }).type,
        );
    }
  }

  /**
   * Broadcast an AgentMessage to all currently connected browser clients.
   *
   * Skips clients whose readyState is not OPEN (e.g. mid-close) to avoid
   * ws.send() throwing on a closing socket.
   */
  broadcast(msg: AgentMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /**
   * Send a message to a single specific client.
   *
   * Used for responses that are only relevant to the client that triggered
   * them (e.g. agent_ready on connect, stream error messages).
   */
  private sendTo(ws: WebSocket, msg: AgentMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Convenience wrapper called from transfer-update callbacks in index.ts.
   * Broadcasts a transfer_update message to all browser tabs so the UI
   * stays in sync regardless of which tab initiated the transfer.
   */
  broadcastTransfer(transfer: Transfer): void {
    this.broadcast({ type: "transfer_update", transfer });
  }
}
