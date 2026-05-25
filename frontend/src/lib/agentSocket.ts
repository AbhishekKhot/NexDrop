import type { AgentMessage, BrowserMessage } from "../types";

// ?agent= query param overrides VITE_AGENT_WS_URL — lets a user open the UI
// against a custom agent (ngrok tunnel, Docker port forward) without rebuilding.
const _queryAgent =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("agent")
    : null;

const AGENT_WS_URL: string =
  _queryAgent ??
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_AGENT_WS_URL ??
  "ws://localhost:4001";

// MUST match backend CHUNK_SIZE in config.ts — divergence corrupts chunk boundaries
const CHUNK_SIZE = 256 * 1024;

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

  private reconnectAttempt = 0;
  private _connectionFailed = false;

  // Defaults to 2 GB before agent_ready arrives so a size check never sees NaN.
  private maxFileSize: number = 2 * 1024 * 1024 * 1024;

  // serial send queue — prevents concurrent streams from interleaving chunks
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
      // WebSocket constructor throws synchronously for invalid URLs
      console.error("[AgentSocket] Failed to create WebSocket:", err);
      this._scheduleReconnect();
      return;
    }

    // arraybuffer required for binary chunk frames — default 'blob' needs an
    // extra async read step before bytes are accessible
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("[AgentSocket] Connected to agent at", AGENT_WS_URL);
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
      // onerror always fires before onclose; reconnect is handled in onclose
      // to avoid scheduling two reconnects
      console.warn("[AgentSocket] WS error (will reconnect)");
    };
  }

  /**
   * Exponential back-off with ±500ms jitter — jitter prevents a thundering
   * herd when multiple tabs lose connection simultaneously (e.g. agent restart)
   * and would otherwise all retry at the same intervals.
   */
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
      Math.random() * 500;

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

  send(msg: BrowserMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[AgentSocket] Not connected; dropping message:", msg.type);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Enqueue rather than send directly: the agent keys in-progress streams by
   * (peerId, fileName) — concurrent sends would interleave binary chunk frames
   * on the WebSocket and the agent would merge chunks from both files into
   * whichever stream is currently active, corrupting the file.
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

  // isProcessingQueue guard prevents re-entry when enqueueFileSend() is called
  // while a send is already running — the while loop picks up the new task.
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
   * Stream a File to the agent in 256 KB binary chunks.
   *
   * file.slice() per chunk (not a single file.arrayBuffer()) keeps memory flat:
   * a 2 GB file via arrayBuffer() would allocate 2 GB of heap at once; slice
   * reads only 256 KB per iteration.
   *
   * Backpressure: poll bufferedAmount at 5 ms intervals; resume at 512 KB
   * (half-drained) rather than fully empty to keep throughput high.
   */
  private async _sendFileStream(
    peerId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agent not connected");
    }

    if (file.size > this.maxFileSize) {
      throw new Error(
        `File "${file.name}" (${file.size} bytes) exceeds the maximum allowed size of ${this.maxFileSize} bytes`,
      );
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

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

      // Frame layout: [4-byte big-endian chunk index][raw chunk bytes].
      // The index lets the agent rebuild the chunks Map regardless of arrival order.
      const frame = new Uint8Array(4 + buf.byteLength);
      new DataView(frame.buffer).setUint32(0, i, false);
      frame.set(new Uint8Array(buf), 4);

      while (this.ws.bufferedAmount > 1_048_576) {
        await new Promise((r) => setTimeout(r, 5));
        if (this.ws.bufferedAmount <= 524_288) break;
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

  /**
   * Authoritative cap from agent_ready — other hooks should read this rather
   * than a hardcoded constant so a backend MAX_FILE_SIZE bump tightens the
   * browser guard without a coordinated frontend change.
   */
  get maxAcceptedFileSize(): number {
    return this.maxFileSize;
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

// Module-level singleton: one WebSocket per browser tab, survives React re-renders.
export const agentSocket = new AgentSocket();
