/**
 * agentSocket.ts
 * WebSocket client that connects to the local PeerDrop agent.
 *
 * Protocol for file send (browser → agent):
 *  1. JSON: { type:'send_file_start', peerId, fileName, fileSize }
 *  2. Binary frames: each is a 256KB ArrayBuffer chunk of the raw file
 *  3. JSON: { type:'send_file_end', peerId, fileName }
 *
 * This avoids loading the whole file into memory as base64.
 */

import type { AgentMessage, BrowserMessage } from "../types";

// Priority: ?agent= query param → VITE_AGENT_WS_URL env → fallback
// This lets you open two tabs against two agents without changing .env:
//   Tab 1: http://localhost:5173         (uses VITE_AGENT_WS_URL or ws://localhost:4001)
//   Tab 2: http://localhost:5173?agent=ws://localhost:4011
const _queryAgent =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("agent")
    : null;

const AGENT_WS_URL: string =
  _queryAgent ??
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_AGENT_WS_URL ??
  "ws://localhost:4001";

const RECONNECT_INTERVAL = 3000;
const CHUNK_SIZE = 256 * 1024; // 256 KB — must match backend config

type MessageHandler = (msg: AgentMessage) => void;
type StatusHandler = (connected: boolean) => void;

class AgentSocket {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  connect(): void {
    this.intentionallyClosed = false;
    this._connect();
  }

  private _connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(AGENT_WS_URL);
    } catch (err) {
      console.error("[AgentSocket] Failed to create WebSocket:", err);
      if (!this.intentionallyClosed) {
        this.reconnectTimer = setTimeout(
          () => this._connect(),
          RECONNECT_INTERVAL,
        );
      }
      return;
    }

    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("[AgentSocket] Connected to agent at", AGENT_WS_URL);
      this._notifyStatus(true);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      // Binary frames are progress/ack messages (future) — skip for now
      if (event.data instanceof ArrayBuffer) return;

      try {
        const msg = JSON.parse(event.data as string) as AgentMessage;
        this.messageHandlers.forEach((h) => h(msg));
      } catch {
        console.error("[AgentSocket] Failed to parse message:", event.data);
      }
    };

    this.ws.onclose = () => {
      console.warn("[AgentSocket] Disconnected from agent");
      this._notifyStatus(false);
      if (!this.intentionallyClosed) {
        this.reconnectTimer = setTimeout(
          () => this._connect(),
          RECONNECT_INTERVAL,
        );
      }
    };

    this.ws.onerror = () => {
      // Suppress error event — onclose will fire right after and handle reconnect
      console.warn("[AgentSocket] WS error (will reconnect)");
    };
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
   * Stream a File to a peer in 256 KB binary chunks.
   * Protocol:
   *   1. JSON send_file_start
   *   2. N binary ArrayBuffer chunks (raw file bytes, NOT encrypted here —
   *      the agent encrypts chunk-by-chunk on the fly)
   *   3. JSON send_file_end
   *
   * @param onProgress called with [0..100] as chunks are read
   */
  async sendFileStream(
    peerId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agent not connected");
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 1. Start marker
    this.ws.send(
      JSON.stringify({
        type: "send_file_start",
        peerId,
        fileName: file.name,
        fileSize: file.size,
        totalChunks,
      } satisfies BrowserMessage),
    );

    // 2. Binary chunk stream
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const slice = file.slice(start, start + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();

      // Attach chunk index as a 4-byte prefix so the agent knows sequence
      const frame = new Uint8Array(4 + buf.byteLength);
      new DataView(frame.buffer).setUint32(0, i, false); // big-endian index
      frame.set(new Uint8Array(buf), 4);

      // Simple backpressure: wait until WS send buffer drains below 1 MB
      while (this.ws.bufferedAmount > 1_048_576) {
        await new Promise((r) => setTimeout(r, 20));
      }

      this.ws.send(frame.buffer);
      onProgress?.(Math.round(((i + 1) / totalChunks) * 100));
    }

    // 3. End marker
    this.ws.send(
      JSON.stringify({
        type: "send_file_end",
        peerId,
        fileName: file.name,
      } satisfies BrowserMessage),
    );
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

  private _notifyStatus(connected: boolean): void {
    this.statusHandlers.forEach((h) => h(connected));
  }
}

// Singleton — one socket per browser tab
export const agentSocket = new AgentSocket();
