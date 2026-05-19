/**
 * agentSocket.ts
 * Singleton WebSocket client that connects the browser to the local NexDrop agent.
 *
 * This module owns the single persistent WebSocket connection per browser tab.
 * All communication with the Node.js backend agent flows through this class:
 *  - JSON control messages (accept/reject transfers, discover peers)
 *  - Binary file chunk streaming for LAN sends
 *
 * Binary streaming protocol (browser → agent):
 *  1. JSON:   { type:'send_file_start', peerId, fileName, fileSize, totalChunks, chunkSize }
 *  2. Binary: N frames — each is [4-byte big-endian chunk index][raw slice bytes]
 *  3. JSON:   { type:'send_file_end', peerId, fileName }
 *
 * Each binary frame carries the chunk index in its header so the agent can
 * reassemble chunks in order even if a rare out-of-order delivery occurs.
 *
 * Fixes applied:
 *  SEC-03  — File size checked against maxFileSize (from agent_ready) before streaming
 *  QUAL-05 — Exponential back-off with jitter on reconnect; gives up after 10 attempts
 *             and surfaces agentFailed=true to the UI via the status handler
 *  CPU-03  — Backpressure poll interval reduced to 5 ms; exits early at 512 KB threshold
 *             to avoid over-polling while still preventing heap accumulation
 *  LOAD-02 — Serial send queue prevents concurrent file streams from interleaving
 *             their chunks and confusing the agent's per-stream tracking
 *  QUAL-04 — chunkSize included in send_file_start frame for agent-side validation
 */

import type { AgentMessage, BrowserMessage } from "../types";

/**
 * Agent URL resolution priority:
 *  1. ?agent= query parameter — allows opening the UI with a custom agent URL
 *     without rebuilding (useful for ngrok tunnels, Docker port-forwarding, etc.)
 *  2. VITE_AGENT_WS_URL env variable — set at build time for production deployments
 *  3. Fallback to localhost:4001 for development
 */
const _queryAgent =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("agent")
    : null;

const AGENT_WS_URL: string =
  _queryAgent ??
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_AGENT_WS_URL ??
  "ws://localhost:4001";

/**
 * Chunk size for binary file streaming.
 * MUST match the backend CHUNK_SIZE in config.ts (256 KB).
 * If these diverge, the agent will assemble chunks of the wrong size and
 * the resulting Buffer will have incorrect data at chunk boundaries.
 */
const CHUNK_SIZE = 256 * 1024;

// ── QUAL-05: Reconnect back-off parameters ────────────────────────────────────

const RECONNECT_BASE_MS = 1_000;       // initial wait before first retry
const RECONNECT_MAX_MS = 30_000;       // cap on exponential growth
const RECONNECT_MAX_ATTEMPTS = 10;     // give up after this many consecutive failures

type MessageHandler = (msg: AgentMessage) => void;
/**
 * Status handler signature.
 * connected: current connection state.
 * failed: true only when max reconnect attempts are exhausted — signals the UI
 *         to show a permanent "agent unreachable" banner (QUAL-05).
 */
type StatusHandler = (connected: boolean, failed?: boolean) => void;

class AgentSocket {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set to true by disconnect() to prevent reconnect loops after intentional close */
  private intentionallyClosed = false;

  // QUAL-05: back-off state
  private reconnectAttempt = 0;
  private _connectionFailed = false;

  /**
   * Maximum file size the agent will accept — populated from the agent_ready
   * message (SEC-03).  Defaults to 2 GB to prevent a divide-by-zero or NaN
   * before the first agent_ready arrives.
   */
  private maxFileSize: number = 2 * 1024 * 1024 * 1024;

  // LOAD-02: serial send queue — prevents concurrent streams from interleaving
  private sendQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;

  /**
   * Start the WebSocket connection and enable automatic reconnection.
   * Safe to call multiple times — resets back-off state and the intentionally-
   * closed flag so a user-triggered reconnect works after a previous failure.
   */
  connect(): void {
    this.intentionallyClosed = false;
    this._connectionFailed = false;
    this.reconnectAttempt = 0;
    this._connect();
  }

  /**
   * Internal connect — creates a new WebSocket and wires up event handlers.
   *
   * Guards against creating a second connection if one is already OPEN, which
   * can happen if connect() is called again before the previous socket fully closes.
   */
  private _connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(AGENT_WS_URL);
    } catch (err) {
      // WebSocket constructor can throw synchronously for invalid URLs
      console.error("[AgentSocket] Failed to create WebSocket:", err);
      this._scheduleReconnect();
      return;
    }

    // arraybuffer is required for binary chunk frames — the default 'blob'
    // type requires an extra async read step before the bytes are accessible
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("[AgentSocket] Connected to agent at", AGENT_WS_URL);
      // QUAL-05: reset back-off counters on successful connection so the next
      // disconnection starts fresh rather than continuing from a high attempt count
      this.reconnectAttempt = 0;
      this._connectionFailed = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this._notifyStatus(true);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      // Binary frames from the agent are not expected (agent → browser is JSON only)
      if (event.data instanceof ArrayBuffer) return;

      try {
        const msg = JSON.parse(event.data as string) as AgentMessage;

        // SEC-03: capture the agent's actual file size limit so the browser
        // can enforce the same limit before streaming begins
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
      // onerror always fires before onclose on a failed connection, but we
      // handle reconnection in onclose to avoid scheduling two reconnects
      console.warn("[AgentSocket] WS error (will reconnect)");
    };
  }

  /**
   * Schedule the next reconnect attempt with exponential back-off and jitter.
   *
   * Back-off formula: min(BASE * 2^attempt, MAX) + random*500ms
   *
   * Why add jitter?
   * Without jitter, if multiple browser tabs all lose connection simultaneously
   * (e.g. agent restart) they would all retry at the same exponential intervals
   * and create a thundering-herd reconnect storm.  The ±500ms jitter spreads
   * reconnect attempts across a window, smoothing the load on the agent.
   *
   * QUAL-05: after RECONNECT_MAX_ATTEMPTS failures, sets _connectionFailed=true
   * and notifies status handlers with failed=true so the UI can show a permanent
   * "agent unreachable" banner instead of an infinite spinner.
   */
  private _scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this._connectionFailed = true;
      console.error(
        "[AgentSocket] Max reconnect attempts reached — giving up. Reload the page or restart the agent.",
      );
      this._notifyStatus(false, true); // failed=true triggers QUAL-05 banner
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

  /**
   * Intentionally close the WebSocket and cancel any pending reconnect.
   * Called on component unmount to avoid reconnect attempts after the UI is gone.
   */
  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Send a typed JSON control message to the agent */
  send(msg: BrowserMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[AgentSocket] Not connected; dropping message:", msg.type);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Enqueue a file send and return a Promise that resolves when it completes.
   *
   * LOAD-02: Why a serial queue instead of sending directly?
   * The agent tracks in-progress streams by (peerId, fileName) key.  If two
   * sends start concurrently their binary chunk frames could interleave on the
   * WebSocket, causing the agent to merge chunks from both files into whichever
   * stream is currently active — resulting in a corrupted file.
   *
   * The queue ensures only one _sendFileStream() runs at a time.  Subsequent
   * sends are held until the preceding one completes.
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

  /**
   * Drain the send queue serially.
   *
   * The isProcessingQueue guard prevents _processQueue() from being entered
   * concurrently if enqueueFileSend() is called while a send is already running
   * (the while loop picks up the newly enqueued task on the next iteration).
   */
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
   * Protocol:
   *  1. send_file_start JSON — agent creates InboundStream record
   *  2. N binary frames     — each carries [4-byte index][slice bytes]
   *  3. send_file_end JSON  — agent assembles Buffer and calls TCP sender
   *
   * Not public — callers must go through enqueueFileSend() to guarantee serial ordering.
   *
   * Backpressure (CPU-03):
   * We poll ws.bufferedAmount at 5 ms intervals (down from 20 ms) to detect when the
   * WebSocket kernel buffer is full.  The exit-early threshold at 512 KB means we
   * resume sending as soon as the buffer is half-drained rather than waiting for it
   * to fully empty — keeping throughput high while preventing heap accumulation.
   *
   * file.slice() per chunk (not a single file.arrayBuffer()):
   * For a 2 GB file, arrayBuffer() would allocate 2 GB of heap at once.
   * slice().arrayBuffer() reads only 256 KB per iteration — constant memory usage
   * regardless of file size.
   */
  private async _sendFileStream(
    peerId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agent not connected");
    }

    // SEC-03: reject before streaming to avoid sending partial data that the
    // agent will reject anyway when it receives send_file_start
    if (file.size > this.maxFileSize) {
      throw new Error(
        `File "${file.name}" (${file.size} bytes) exceeds the maximum allowed size of ${this.maxFileSize} bytes`,
      );
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // QUAL-04: include chunkSize so agent can log/validate slice boundaries
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
      const slice = file.slice(start, start + CHUNK_SIZE); // constant-memory read
      const buf = await slice.arrayBuffer();

      // Frame layout: [4-byte big-endian chunk index][raw chunk bytes]
      // The index lets the agent build the chunks Map regardless of arrival order
      const frame = new Uint8Array(4 + buf.byteLength);
      new DataView(frame.buffer).setUint32(0, i, false); // big-endian
      frame.set(new Uint8Array(buf), 4);

      // CPU-03: backpressure — wait if the WebSocket send buffer is too full
      // Threshold 1 MB: stop sending; resume at 512 KB (half-drained)
      while (this.ws.bufferedAmount > 1_048_576) {
        await new Promise((r) => setTimeout(r, 5)); // 5 ms poll
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

  /**
   * Public entry point for file sending — delegates to the serial queue.
   * Kept as a named method (not just enqueueFileSend) so call sites read
   * naturally: agentSocket.sendFileStream(peerId, file).
   */
  async sendFileStream(
    peerId: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return this.enqueueFileSend(peerId, file, onProgress);
  }

  /**
   * Register a handler for incoming agent messages.
   * Returns an unsubscribe function so callers can clean up in useEffect.
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Register a handler for connection status changes.
   * Returns an unsubscribe function.
   */
  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Authoritative file-size cap reported by the agent in agent_ready.
   *
   * Other hooks (notably useRemoteTransfer) should consult this rather than a
   * hardcoded constant so that raising MAX_FILE_SIZE on the backend immediately
   * tightens the browser-side guard without a coordinated frontend change.
   *
   * Defaults to the same 2 GB value the agent uses until agent_ready arrives.
   */
  get maxAcceptedFileSize(): number {
    return this.maxFileSize;
  }

  /** True after max reconnect attempts are exhausted (QUAL-05) */
  get connectionFailed(): boolean {
    return this._connectionFailed;
  }

  /** Number of file sends waiting in the serial queue (useful for debugging) */
  get queueDepth(): number {
    return this.sendQueue.length;
  }

  /**
   * Notify all registered status handlers.
   * failed defaults to false so normal connect/disconnect calls don't need to pass it.
   */
  private _notifyStatus(connected: boolean, failed = false): void {
    this.statusHandlers.forEach((h) => h(connected, failed));
  }
}

/**
 * Singleton instance — one WebSocket connection per browser tab.
 *
 * Using a module-level singleton means the connection survives React re-renders
 * and component remounts.  All React components that need agent communication
 * import this same instance via useAgentSocket().
 */
export const agentSocket = new AgentSocket();
