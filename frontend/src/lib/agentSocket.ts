/**
 * agentSocket.ts
 * WebSocket client that connects to the local NexDrop agent.
 *
 * Binary file send protocol (browser → agent):
 *  1. JSON: send_file_start (includes chunkSize for QUAL-04)
 *  2. Binary frames: [4-byte big-endian chunk index][raw slice bytes]
 *  3. JSON: send_file_end
 *
 * Fixes applied:
 *  SEC-03  — File size check against maxFileSize from agent_ready before sending
 *  QUAL-05 — Exponential back-off with jitter on reconnect; gives up after 10 attempts
 *  CPU-03  — Backpressure poll interval reduced from 20 ms → 5 ms; exits early at 512 KB
 *  LOAD-02 — Serial send queue so concurrent sends don't corrupt stream tracking
 *  QUAL-04 — chunkSize sent in send_file_start frame
 */

import type { AgentMessage, BrowserMessage } from "../types";

const _queryAgent =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("agent")
    : null;

const AGENT_WS_URL: string =
  _queryAgent ??
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_AGENT_WS_URL ??
  "ws://localhost:4001";

const CHUNK_SIZE = 256 * 1024; // 256 KB — must match backend config

// QUAL-05: reconnect back-off parameters
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;

type MessageHandler = (msg: AgentMessage) => void;
type StatusHandler = (connected: boolean, failed?: boolean) => void;

class AgentSocket {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  // QUAL-05: exponential back-off state
  private reconnectAttempt = 0;
  private _connectionFailed = false;

  // SEC-03: populated from agent_ready message
  private maxFileSize: number = 2 * 1024 * 1024 * 1024; // 2 GB default

  // LOAD-02: serial send queue
  private sendQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;

  connect(): void {
    this.intentionallyClosed = false;
    this._connectionFailed = false;
    this.reconnectAttempt = 0;
    this._connect();
  }

  private _connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(AGENT_WS_URL);
    } catch (err) {
      console.error("[AgentSocket] Failed to create WebSocket:", err);
      this._scheduleReconnect();
      return;
    }

    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("[AgentSocket] Connected to agent at", AGENT_WS_URL);
      // QUAL-05: reset back-off on successful connection
      this.reconnectAttempt = 0;
      this._connectionFailed = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this._notifyStatus(true);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) return;

      try {
        const msg = JSON.parse(event.data as string) as AgentMessage;

        // SEC-03: capture maxFileSize from agent
        if (msg.type === "agent_ready") {
          this.maxFileSize = msg.maxFileSize ?? this.maxFileSize;
        }

        this.messageHandlers.forEach((h) => h(msg));
      } catch {
        console.error("[AgentSocket] Failed to parse message:", event.data);
      }
    };

    this.ws.onclose = () => {
      console.warn("[AgentSocket] Disconnected from agent");
      this._notifyStatus(false);
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      console.warn("[AgentSocket] WS error (will reconnect)");
    };
  }

  /** QUAL-05: exponential back-off with jitter; stops after max attempts */
  private _scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this._connectionFailed = true;
      console.error(
        "[AgentSocket] Max reconnect attempts reached — giving up. Reload the page or restart the agent.",
      );
      this._notifyStatus(false, true);
      return;
    }

    const delay =
      Math.min(
        RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
        RECONNECT_MAX_MS,
      ) +
      Math.random() * 500; // jitter

    console.log(
      `[AgentSocket] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt + 1}/${RECONNECT_MAX_ATTEMPTS})`,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Send a typed JSON control message */
  send(msg: BrowserMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[AgentSocket] Not connected; dropping message:", msg.type);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Enqueue a file send — LOAD-02: processes sends serially to prevent
   * concurrent chunk streams corrupting each other's tracking state.
   */
  enqueueFileSend(
    peerId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sendQueue.push(async () => {
        try {
          await this._sendFileStream(peerId, file, onProgress);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      this._processQueue();
    });
  }

  private async _processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    while (this.sendQueue.length > 0) {
      const task = this.sendQueue.shift()!;
      await task();
    }
    this.isProcessingQueue = false;
  }

  /**
   * Stream a File to a peer in 256 KB binary chunks.
   * Not public — callers must use enqueueFileSend to maintain serial ordering.
   */
  private async _sendFileStream(
    peerId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agent not connected");
    }

    // SEC-03: check file size before streaming
    if (file.size > this.maxFileSize) {
      throw new Error(
        `File "${file.name}" (${file.size} bytes) exceeds the maximum allowed size of ${this.maxFileSize} bytes`,
      );
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // QUAL-04: include chunkSize in start frame
    this.ws.send(
      JSON.stringify({
        type: "send_file_start",
        peerId,
        fileName: file.name,
        fileSize: file.size,
        totalChunks,
        chunkSize: CHUNK_SIZE,
      } satisfies BrowserMessage),
    );

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const slice = file.slice(start, start + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();

      const frame = new Uint8Array(4 + buf.byteLength);
      new DataView(frame.buffer).setUint32(0, i, false); // big-endian index
      frame.set(new Uint8Array(buf), 4);

      // CPU-03: tighter backpressure loop — 5 ms poll, exit at 512 KB threshold
      while (this.ws.bufferedAmount > 1_048_576) {
        await new Promise((r) => setTimeout(r, 5));
        if (this.ws.bufferedAmount <= 524_288) break; // exit early at 512 KB
      }

      this.ws.send(frame.buffer);
      onProgress?.(Math.round(((i + 1) / totalChunks) * 100));
    }

    this.ws.send(
      JSON.stringify({
        type: "send_file_end",
        peerId,
        fileName: file.name,
      } satisfies BrowserMessage),
    );
  }

  /** Kept for direct use by non-queued callers (e.g. control messages only) */
  async sendFileStream(
    peerId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return this.enqueueFileSend(peerId, file, onProgress);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get connectionFailed(): boolean {
    return this._connectionFailed;
  }

  get queueDepth(): number {
    return this.sendQueue.length;
  }

  private _notifyStatus(connected: boolean, failed = false): void {
    this.statusHandlers.forEach((h) => h(connected, failed));
  }
}

// Singleton — one socket per browser tab
export const agentSocket = new AgentSocket();
