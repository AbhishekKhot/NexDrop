/**
 * tcpClient.ts
 * TCP client — sends a file to a LAN peer over an encrypted connection.
 *
 * Wire protocol (CPU-02 — binary length-prefix framing):
 *  Each frame: [1-byte type][4-byte big-endian payload-length][payload bytes]
 *
 *  Control frames (PUBLIC_KEY, METADATA, DONE): JSON payload
 *  CHUNK frame: binary payload = [12-byte IV][16-byte authTag][ciphertext]
 *
 * Transfer lifecycle per call to sendFileToPeer():
 *  1. Open TCP connection to peer's IP:port
 *  2. Receive peer's PUBLIC_KEY frame → compute session key via ECDH
 *  3. Send METADATA (file info + our ECDH public key + chunkSize)
 *  4. Wait for peer's ACCEPT or REJECT frame
 *  5. Stream N × binary CHUNK frames (IV + authTag + ciphertext)
 *  6. Send DONE frame (includes full-file SHA-256 for integrity verification)
 *  7. Gracefully close the connection
 *
 * Security / performance fixes applied:
 *  SEC-02  — File size checked before opening any socket (fail fast)
 *  CPU-02  — Binary CHUNK framing eliminates base64 overhead (~33% reduction)
 *  QUAL-04 — chunkSize included in METADATA so receiver knows slice boundaries
 *  LOAD-03 — Optional token-bucket rate limiter via MAX_TRANSFER_BPS
 */

import net from "net";
import { v4 as uuidv4 } from "uuid";
import { generateECDHPair, computeSessionKey } from "../crypto/aesGcm";
import { chunkFile, hashFile } from "../chunking/chunker";
import type { Transfer, TcpControlFrame } from "../types";
import { TcpFrameType, PROTOCOL_VERSION } from "../types";
import { CHUNK_SIZE, MAX_FILE_SIZE, MAX_TRANSFER_BPS } from "../config";

export type TransferUpdateCallback = (transfer: Transfer) => void;

// ── Frame writer helpers ──────────────────────────────────────────────────────

/**
 * Write a JSON control frame to a socket.
 *
 * Frame layout: [1-byte type][4-byte big-endian length][UTF-8 JSON bytes]
 *
 * Returns the socket.write() return value (false = backpressure; caller may
 * want to wait for 'drain' before sending more data, though for control frames
 * — which are tiny — this almost never triggers in practice).
 */
function writeControlFrame(
  socket: net.Socket,
  typeByte: number,
  payload: object,
): boolean {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(typeByte, 0);
  header.writeUInt32BE(json.length, 1);
  return socket.write(Buffer.concat([header, json]));
}

/**
 * Write a binary CHUNK frame to a socket.
 *
 * Frame layout: [1-byte CHUNK type][4-byte length][12-byte IV][16-byte authTag][ciphertext]
 *
 * Why inline IV and authTag into the frame payload rather than using separate frames?
 *  - Fewer round trips: receiver extracts IV and authTag from fixed byte offsets.
 *  - No extra JSON parsing on the hot path (hundreds of frames per second for large files).
 *  - The fixed offsets (0..11 = IV, 12..27 = authTag, 28.. = ciphertext) are documented
 *    in types.ts and mirrored in tcpServer.ts — both sides must stay in sync.
 *
 * Returns false if the socket kernel buffer is full (backpressure); caller should
 * wait for 'drain' before sending more chunks to avoid unbounded memory growth.
 */
function writeChunkFrame(
  socket: net.Socket,
  iv: Buffer,
  authTag: Buffer,
  ciphertext: Buffer,
): boolean {
  const payloadLen = iv.length + authTag.length + ciphertext.length;
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(TcpFrameType.CHUNK, 0);
  header.writeUInt32BE(payloadLen, 1);
  // Single write keeps IV + authTag + ciphertext in one TCP segment
  return socket.write(Buffer.concat([header, iv, authTag, ciphertext]));
}

// ── Token-bucket rate limiter (LOAD-03) ──────────────────────────────────────

/**
 * Simple token-bucket rate limiter that enforces a bytes/second ceiling.
 *
 * Why token bucket instead of a fixed sleep between chunks?
 *  - A fixed sleep can't adapt to variable chunk sizes (last chunk is smaller).
 *  - Token bucket naturally handles bursts: if the previous chunk sent quickly
 *    tokens accumulate, allowing the next chunk to send without waiting.
 *  - The refill calculation (elapsed * bytesPerSec) correctly accounts for the
 *    actual time passed rather than a nominal interval, so drift doesn't build up.
 *
 * Edge case — large chunks with few tokens:
 * If tokens < bytes, we calculate how long to wait for enough tokens to accumulate
 * and sleep that exact duration rather than spinning in a tight loop.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  /**
   * @param bytesPerSec Maximum sustained throughput in bytes per second.
   *                    Initialised with a full bucket so the first chunk
   *                    doesn't have to wait.
   */
  constructor(private bytesPerSec: number) {
    this.tokens = bytesPerSec; // start full
    this.lastRefill = Date.now();
  }

  /**
   * Consume `bytes` tokens, sleeping if necessary until enough tokens accumulate.
   * Returns a Promise so the caller can await without blocking the event loop.
   */
  async consume(bytes: number): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    // Refill — cap at one bucket's worth to prevent token hoarding after idle periods
    this.tokens = Math.min(this.bytesPerSec, this.tokens + elapsed * this.bytesPerSec);
    this.lastRefill = now;

    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return; // enough tokens — no wait needed
    }

    // Not enough tokens; calculate exact wait time and sleep
    const needed = bytes - this.tokens;
    const waitMs = Math.ceil((needed / this.bytesPerSec) * 1000);
    this.tokens = 0;
    await new Promise<void>((r) => setTimeout(r, waitMs));
  }
}

// ── Frame parser helper ───────────────────────────────────────────────────────

/**
 * Attempt to parse a JSON control frame payload into a typed TcpControlFrame.
 *
 * Returns null on JSON parse failure rather than throwing, so the caller can
 * handle malformed frames gracefully (log and ignore) instead of crashing.
 */
function parseControlFrame(data: Buffer): TcpControlFrame | null {
  try {
    return JSON.parse(data.toString("utf8")) as TcpControlFrame;
  } catch {
    return null;
  }
}

// ── Main send function ────────────────────────────────────────────────────────

/**
 * Send a file to a LAN peer via TCP with end-to-end AES-256-GCM encryption.
 *
 * The function wraps the entire TCP lifecycle in a Promise so callers can
 * await it and be notified when the transfer completes or fails.
 *
 * @param peerIp      IP address of the peer's agent.
 * @param peerPort    TCP port the peer's agent is listening on.
 * @param peerId      Stable device UUID for the peer (from mDNS discovery).
 * @param peerName    Human-readable peer name shown in the browser UI.
 * @param fileBuffer  Full file contents loaded into memory by wsApi.ts.
 * @param fileName    Original file name; used in METADATA and for UI display.
 * @param onUpdate    Callback invoked on every state change; relayed to browser.
 */
export async function sendFileToPeer(
  peerIp: string,
  peerPort: number,
  peerId: string,
  peerName: string,
  fileBuffer: Buffer,
  fileName: string,
  onUpdate: TransferUpdateCallback,
): Promise<void> {
  // SEC-02: reject oversized files before opening any socket.
  // Doing this check here (before the TCP connection) avoids wasting the
  // peer's connection slot and our own file descriptor on a transfer we'll
  // reject immediately.
  if (fileBuffer.length > MAX_FILE_SIZE) {
    const msg = `File "${fileName}" (${fileBuffer.length} bytes) exceeds the maximum allowed size of ${MAX_FILE_SIZE} bytes`;
    console.error("[TCP Client]", msg);
    onUpdate({
      id: uuidv4(),
      peerId,
      peerName,
      direction: "send",
      fileName,
      fileSize: fileBuffer.length,
      totalChunks: 0,
      chunksReceived: 0,
      state: "error",
      errorMessage: msg,
    });
    return;
  }

  const transferId = uuidv4();
  // Generate our ephemeral key pair now — we'll complete the ECDH exchange
  // once we receive the peer's PUBLIC_KEY frame
  const myEcdh = generateECDHPair();
  // Compute the full-file hash upfront so it's ready for the DONE frame
  const fileHash = hashFile(fileBuffer);
  // Instantiate rate limiter if configured; null = no limiting
  const rateLimiter = MAX_TRANSFER_BPS ? new TokenBucket(MAX_TRANSFER_BPS) : null;

  const transfer: Transfer = {
    id: transferId,
    peerId,
    peerName,
    direction: "send",
    fileName,
    fileSize: fileBuffer.length,
    totalChunks: 0,   // updated once we know chunkCount after ECDH
    chunksReceived: 0,
    state: "pending",
    startedAt: Date.now(),
  };
  onUpdate(transfer);

  // Wrap the entire TCP session in a Promise so the caller can await completion.
  // resolve() is called on normal exit (completed or rejected);
  // reject() is called only on unexpected socket errors.
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(
      { host: peerIp, port: peerPort },
      () => {
        console.log(
          `[TCP Client] Connected to ${peerIp}:${peerPort} for transfer ${transferId}`,
        );
      },
    );

    // Binary frame accumulation buffer — same pattern as tcpServer.ts
    let readBuf = Buffer.alloc(0);

    // Explicit state machine to make the protocol flow readable.
    // Transitions:  waiting_key → waiting_accept → sending → done
    let state: "waiting_key" | "waiting_accept" | "sending" | "done" =
      "waiting_key";

    socket.on("data", (data) => {
      readBuf = Buffer.concat([readBuf, data]);

      // Parse as many complete frames as available
      while (readBuf.length >= 5) {
        const typeByte = readBuf.readUInt8(0);
        const payloadLen = readBuf.readUInt32BE(1);
        if (readBuf.length < 5 + payloadLen) break;

        const payload = readBuf.subarray(5, 5 + payloadLen);
        readBuf = readBuf.subarray(5 + payloadLen);

        handleFrame(typeByte, payload);
      }
    });

    /**
     * Handle a fully-parsed frame from the server.
     *
     * The explicit `state` guard on each case prevents out-of-order frames
     * from causing unexpected behaviour (e.g. receiving an ACCEPT when we
     * haven't even sent METADATA yet would be silently ignored).
     */
    function handleFrame(typeByte: number, payload: Buffer): void {
      const frame = parseControlFrame(payload);
      if (!frame) return;

      // ── Step 2: received peer's public key → send METADATA ─────────────────
      if (
        state === "waiting_key" &&
        typeByte === TcpFrameType.PUBLIC_KEY &&
        frame.kind === "PUBLIC_KEY"
      ) {
        // Complete the ECDH exchange: compute the shared session key
        const sessionKey = computeSessionKey(myEcdh.ecdh, frame.publicKey);
        const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);
        transfer.totalChunks = totalChunks;

        // QUAL-04: include chunkSize so the receiver knows slice boundaries.
        // PROTOCOL_VERSION lets the receiver detect framing incompatibilities.
        writeControlFrame(socket, TcpFrameType.METADATA, {
          kind: "METADATA",
          payload: {
            transferId,
            fileName,
            fileSize: fileBuffer.length,
            totalChunks,
            fileHash,
            senderPublicKey: myEcdh.publicKeyHex,
            chunkSize: CHUNK_SIZE,
            protocolVersion: PROTOCOL_VERSION,
          },
        });

        onUpdate({ ...transfer, state: "pending" });
        state = "waiting_accept";

        // Store sessionKey on the socket object so it's accessible in the
        // ACCEPT handler, which runs in the same data event callback chain.
        // This avoids a closure variable that would need to be carefully managed
        // across the async sendChunks() call below.
        (socket as typeof socket & { _sessionKey?: Buffer })._sessionKey =
          sessionKey;
      }

      // ── Step 4a: peer accepted → start streaming chunks ───────────────────
      if (
        state === "waiting_accept" &&
        typeByte === TcpFrameType.ACCEPT &&
        frame.kind === "ACCEPT" &&
        frame.transferId === transferId
      ) {
        onUpdate({ ...transfer, state: "accepted" });
        state = "sending";
        const sk = (socket as typeof socket & { _sessionKey?: Buffer })._sessionKey;
        // sendChunks is async but we don't await it here — it runs concurrently
        // with the socket's data event handler.  This is safe because we're now
        // in "sending" state and no more frames from the peer are expected until
        // the transfer completes.
        if (sk) sendChunks(sk);
      }

      // ── Step 4b: peer rejected → close gracefully ─────────────────────────
      if (
        typeByte === TcpFrameType.REJECT &&
        frame.kind === "REJECT" &&
        frame.transferId === transferId
      ) {
        onUpdate({ ...transfer, state: "rejected" });
        socket.destroy();
        resolve(); // rejected is a normal termination, not an error
      }
    }

    /**
     * Encrypt and stream all chunks to the peer, then send the DONE frame.
     *
     * Backpressure handling: writeChunkFrame() returns false when the socket's
     * kernel send buffer is full (TCP flow control).  We await 'drain' before
     * continuing so we don't accumulate unbounded data in Node's JS heap.
     *
     * Rate limiting: if MAX_TRANSFER_BPS is set, each chunk awaits the token
     * bucket before being written — this caps CPU and network usage during
     * batch transfers.
     */
    async function sendChunks(sessionKey: Buffer): Promise<void> {
      onUpdate({ ...transfer, state: "transferring" });
      // chunkFile() encrypts every slice with a fresh IV — pure CPU work done
      // synchronously here.  For very large files this could be moved to a
      // worker thread, but at 256 KB chunks it's fast enough on the event loop.
      const chunks = chunkFile(transferId, fileBuffer, sessionKey);

      for (const chunk of chunks) {
        // LOAD-03: throttle send rate if configured
        if (rateLimiter) {
          await rateLimiter.consume(chunk.data.length);
        }

        // CPU-02: binary frame — no JSON serialisation, no base64
        const canContinue = writeChunkFrame(
          socket,
          chunk.iv,
          chunk.authTag,
          chunk.data,
        );

        // Backpressure: wait for the socket buffer to drain before continuing
        if (!canContinue) {
          await new Promise<void>((r) => socket.once("drain", r));
        }

        // Report progress to the browser on every chunk
        onUpdate({
          ...transfer,
          state: "transferring",
          chunksReceived: chunk.index + 1,
        });
      }

      // Signal end of transfer — receiver verifies the assembled file against fileHash
      writeControlFrame(socket, TcpFrameType.DONE, {
        kind: "DONE",
        transferId,
        fileHash,
      });
      // Graceful TCP close: sends FIN; receiver's socket.end() will complete the close
      socket.end();

      onUpdate({ ...transfer, state: "completed", completedAt: Date.now() });
      state = "done";
      resolve();
    }

    socket.on("error", (err) => {
      console.error("[TCP Client] Error:", err.message);
      onUpdate({ ...transfer, state: "error", errorMessage: err.message });
      reject(err);
    });

    socket.on("close", () => {
      console.log("[TCP Client] Connection closed");
      // Resolve (not reject) if we get an unexpected close before "done" —
      // the transfer update above already marked the state as error if needed
      if (state !== "done") resolve();
    });
  });
}
