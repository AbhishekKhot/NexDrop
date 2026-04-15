/**
 * tcpServer.ts
 * TCP server — receives incoming LAN file transfers from peers.
 *
 * Wire protocol (CPU-02 — binary length-prefix framing):
 *  Each frame: [1-byte type][4-byte big-endian payload-length][payload bytes]
 *
 *  Control frames (PUBLIC_KEY, METADATA, ACCEPT, REJECT, DONE): JSON payload
 *  CHUNK frame: binary payload = [12-byte IV][16-byte authTag][ciphertext]
 *
 * Transfer lifecycle per connection:
 *  1. Server sends PUBLIC_KEY (our ECDH ephemeral public key)
 *  2. Client sends METADATA   (file info + client's ECDH public key)
 *     → Session key derived from ECDH exchange
 *     → Transfer offer shown to user (60 s timeout)
 *  3. Server sends ACCEPT or REJECT based on user decision
 *  4. Client streams N × CHUNK frames (binary — IV + authTag + ciphertext)
 *  5. Client sends DONE (includes full-file SHA-256 hex)
 *  6. Server verifies, assembles, writes file atomically to disk
 *
 * One TCP connection = one file transfer.  The connection is closed (server
 * calls socket.end()) after the DONE frame is processed.
 *
 * Security / reliability fixes applied:
 *  SEC-01  — Reject transfers exceeding MAX_FILE_SIZE before accepting
 *  SEC-04  — All fs operations async (no blocking event loop)
 *  SEC-05  — Atomic write: write to .nexdrop-tmp first, then fs.rename()
 *  LOAD-01 — server.maxConnections cap + per-IP connection counter
 *  ERR-03  — socket.setTimeout(30 s) to detect stalled senders
 *  CPU-02  — Binary length-prefix framing (no JSON, no base64 on CHUNK path)
 *  QUAL-04 — chunkSize negotiated from sender's METADATA frame
 */

import net from "net";
import fs from "fs";
import path from "path";
import {
  TCP_PORT,
  DOWNLOAD_DIR,
  MAX_FILE_SIZE,
  TCP_MAX_CONNECTIONS,
  TCP_MAX_CONN_PER_IP,
} from "../config";
import type { FileMetadata, Chunk, Transfer } from "../types";
import { TcpFrameType } from "../types";
import { computeSessionKey, generateECDHPair } from "../crypto/aesGcm";
import { assembleChunks } from "../chunking/assembler";

export type TransferUpdateCallback = (transfer: Transfer) => void;
export type IncomingOfferCallback = (transfer: Transfer) => void;

// ── User decision gate ────────────────────────────────────────────────────────

/**
 * Tracks pending accept/reject decisions for incoming transfers.
 *
 * When a METADATA frame arrives the server needs to pause and wait for the
 * user to click Accept or Reject in the browser UI.  PendingDecisionMap
 * bridges this async gap: tcpServer registers a Promise; wsApi resolves it
 * when the browser sends accept_transfer or reject_transfer.
 *
 * Auto-timeout (60 s):
 * If the user doesn't respond within 60 seconds the transfer is automatically
 * rejected.  Without this, the sender's TCP socket would be held open
 * indefinitely waiting for an ACCEPT or REJECT frame.
 */
export class PendingDecisionMap {
  private map = new Map<string, { resolve: (accepted: boolean) => void }>();

  /**
   * Register a new pending decision and return a Promise that resolves to
   * true (accepted) or false (rejected / timed out).
   *
   * The timer is cleared if the user responds — avoids a spurious rejection
   * arriving after the user already clicked Accept.
   */
  register(transferId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.map.delete(transferId);
        resolve(false); // auto-reject on timeout
      }, 60_000);

      this.map.set(transferId, {
        resolve: (accepted: boolean) => {
          clearTimeout(timer);
          this.map.delete(transferId);
          resolve(accepted);
        },
      });
    });
  }

  /**
   * Called by wsApi when the browser sends accept_transfer or reject_transfer.
   * Resolves the corresponding registered Promise.
   */
  respond(transferId: string, accepted: boolean): void {
    this.map.get(transferId)?.resolve(accepted);
  }
}

// ── Per-IP connection tracking (LOAD-01) ──────────────────────────────────────

/**
 * Tracks how many active TCP connections exist per remote IP address.
 *
 * Stored as a module-level Map (not inside the server callback closure) so
 * the count persists correctly across multiple simultaneous connections.
 *
 * Why track per-IP in addition to the global server.maxConnections?
 * The global cap prevents overall resource exhaustion, but without per-IP
 * tracking a single host could hold all global slots and deny service to
 * every other peer on the network.
 */
const ipConnections = new Map<string, number>();

/**
 * Increment the connection count for an IP.
 * Returns false if the per-IP limit is already reached (caller should reject).
 */
function trackIp(ip: string): boolean {
  const count = ipConnections.get(ip) ?? 0;
  if (count >= TCP_MAX_CONN_PER_IP) return false;
  ipConnections.set(ip, count + 1);
  return true;
}

/**
 * Decrement the connection count for an IP.
 * Deletes the entry entirely when it reaches zero to avoid unbounded Map growth.
 */
function untrackIp(ip: string): void {
  const count = ipConnections.get(ip) ?? 1;
  if (count <= 1) ipConnections.delete(ip);
  else ipConnections.set(ip, count - 1);
}

// ── Frame writer helpers ──────────────────────────────────────────────────────

/**
 * Write a JSON control frame to a socket.
 *
 * Frame layout: [1-byte type][4-byte big-endian length][JSON payload bytes]
 *
 * Using a single socket.write() with a concatenated Buffer ensures the header
 * and payload are sent in one TCP segment rather than two separate ones.
 * This avoids the Nagle-algorithm delay that can occur when the kernel decides
 * not to flush a small header until more data arrives.
 */
function writeControlFrame(
  socket: net.Socket,
  typeByte: number,
  payload: object,
): void {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(5); // 1 byte type + 4 bytes length
  header.writeUInt8(typeByte, 0);
  header.writeUInt32BE(json.length, 1);
  socket.write(Buffer.concat([header, json]));
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create and start the TCP server that receives incoming LAN file transfers.
 *
 * @param pendingDecisions  Shared decision map — resolves when user accepts/rejects.
 * @param onOffer           Called when a METADATA frame arrives; triggers the UI modal.
 * @param onUpdate          Called on every transfer state change; relayed to the browser.
 */
export function createTcpServer(
  pendingDecisions: PendingDecisionMap,
  onOffer: IncomingOfferCallback,
  onUpdate: TransferUpdateCallback,
): net.Server {
  const server = net.createServer((socket) => {
    const remoteIp = socket.remoteAddress ?? "unknown";

    // ── Per-IP connection limit (LOAD-01) ────────────────────────────────────
    // Checked before any data is read — destroys the socket immediately if the
    // IP already holds too many connections.  Cheaper than reading a METADATA
    // frame and then rejecting.
    if (!trackIp(remoteIp)) {
      console.warn(
        `[TCP Server] Rejected connection from ${remoteIp} — per-IP limit (${TCP_MAX_CONN_PER_IP}) reached`,
      );
      socket.destroy();
      return;
    }

    console.log(
      `[TCP Server] Connection from ${remoteIp}:${socket.remotePort}`,
    );

    // ── Inactivity timeout (ERR-03) ──────────────────────────────────────────
    // socket.setTimeout() arms a timer that fires if no data arrives for 30 s.
    // Node resets the timer automatically on every 'data' event, so legitimate
    // slow senders (large files on a slow link) won't trigger it.
    //
    // Without this, a sender that opens a connection and then stalls (network
    // partition, crash, bug) would hold the socket open indefinitely, leaking
    // the file descriptor and the per-IP slot.
    socket.setTimeout(30_000);
    socket.on("timeout", () => {
      console.warn(`[TCP Server] Inactivity timeout from ${remoteIp} — closing`);
      // Report the partial transfer as an error so the browser UI updates
      if (metadata && transferId) {
        onUpdate({
          id: transferId,
          peerId: remoteIp,
          peerName: remoteIp,
          direction: "receive",
          fileName: metadata.fileName,
          fileSize: metadata.fileSize,
          totalChunks: metadata.totalChunks,
          chunksReceived: receivedChunks.length,
          state: "error",
          errorMessage: "Transfer timed out — sender went silent",
        });
      }
      socket.destroy();
    });

    // ── Binary frame parser state (CPU-02) ───────────────────────────────────
    // readBuf accumulates incoming TCP data; frames are parsed out as complete
    // header+payload sequences become available.  Multiple frames may arrive
    // in a single 'data' event (Nagle coalescing); a single frame may arrive
    // across multiple events (large payload split across MTU boundaries).
    let readBuf = Buffer.alloc(0);

    // Per-connection transfer state — cleared/set by frame handlers
    let metadata: FileMetadata | null = null;
    let receivedChunks: Chunk[] = [];
    let sessionKey: Buffer | null = null;
    let transferId: string | null = null;
    let bytesReceived = 0; // SEC-01: running total for mid-transfer size guard

    // Generate our ephemeral ECDH key pair and immediately send our public key.
    // This initiates the key exchange — the sender computes the session key
    // once it receives this public key.
    const myEcdh = generateECDHPair();
    writeControlFrame(socket, TcpFrameType.PUBLIC_KEY, {
      kind: "PUBLIC_KEY",
      publicKey: myEcdh.publicKeyHex,
    });

    socket.on("data", (incoming) => {
      // Append new data to the accumulation buffer, then attempt to parse frames.
      // Buffer.concat is O(n) in the size of incoming; for CHUNK frames the
      // payload is the dominant cost and is unavoidable.
      readBuf = Buffer.concat([readBuf, incoming]);
      parseFrames();
    });

    /**
     * Parse as many complete frames as possible from readBuf.
     *
     * Loop invariant: we only consume bytes we've fully read.
     * If the buffer doesn't yet contain a complete frame, we break and wait
     * for the next 'data' event to bring more bytes.
     */
    function parseFrames(): void {
      // Minimum frame size is 5 bytes (1 type + 4 length)
      while (readBuf.length >= 5) {
        const typeByte = readBuf.readUInt8(0);
        const payloadLen = readBuf.readUInt32BE(1);

        // Wait for the full payload to arrive before processing
        if (readBuf.length < 5 + payloadLen) break;

        const payload = readBuf.subarray(5, 5 + payloadLen);
        // Advance the read cursor past the consumed frame
        readBuf = readBuf.subarray(5 + payloadLen);

        // handleFrame is async (disk I/O in DONE handler) — attach a .catch()
        // so any unhandled rejection destroys the socket rather than silently failing
        handleFrame(typeByte, payload).catch((err) => {
          console.error("[TCP Server] Frame handler error:", err);
          socket.destroy();
        });
      }
    }

    /**
     * Dispatch a parsed frame to the appropriate handler based on its type byte.
     *
     * Async because the DONE handler performs disk I/O (mkdir, writeFile, rename).
     * Keeping all frame handling in one switch keeps the protocol state machine
     * easy to follow.
     */
    async function handleFrame(
      typeByte: number,
      payload: Buffer,
    ): Promise<void> {
      switch (typeByte) {
        // ── METADATA: file info + sender's ECDH public key ────────────────────
        case TcpFrameType.METADATA: {
          let parsed: { kind: string; payload: FileMetadata };
          try {
            parsed = JSON.parse(payload.toString("utf8"));
          } catch {
            console.error("[TCP Server] Bad METADATA JSON");
            socket.destroy();
            return;
          }
          metadata = parsed.payload;
          transferId = metadata.transferId;

          // SEC-01: reject oversized files before accepting.
          // Doing this check here (in METADATA) rather than waiting for DONE
          // means we don't waste time receiving chunks for a file we'll reject.
          if (metadata.fileSize > MAX_FILE_SIZE) {
            console.warn(
              `[TCP Server] Rejecting oversized file: ${metadata.fileSize} bytes > ${MAX_FILE_SIZE}`,
            );
            writeControlFrame(socket, TcpFrameType.REJECT, {
              kind: "REJECT",
              transferId,
            });
            socket.destroy();
            return;
          }

          // Derive session key now that we have the sender's public key.
          // Both sides compute the same secret from their private key + the peer's public key.
          sessionKey = computeSessionKey(myEcdh.ecdh, metadata.senderPublicKey);

          const transfer: Transfer = {
            id: transferId,
            peerId: socket.remoteAddress ?? "unknown",
            peerName: socket.remoteAddress ?? "Unknown",
            direction: "receive",
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            totalChunks: metadata.totalChunks,
            chunksReceived: 0,
            state: "pending",
            startedAt: Date.now(),
          };

          // Notify the browser — shows the incoming transfer modal
          onOffer(transfer);

          // Wait (asynchronously) for the user's decision.
          // The connection stays open and keeps accumulating data events while
          // we wait — the binary parser will queue any frames that arrive before
          // the decision, though in practice the sender waits for ACCEPT/REJECT
          // before streaming chunks.
          pendingDecisions.register(transferId).then((accepted) => {
            if (!accepted) {
              writeControlFrame(socket, TcpFrameType.REJECT, {
                kind: "REJECT",
                transferId,
              });
              socket.destroy();
              onUpdate({ ...transfer, state: "rejected" });
            } else {
              writeControlFrame(socket, TcpFrameType.ACCEPT, {
                kind: "ACCEPT",
                transferId,
              });
              onUpdate({ ...transfer, state: "accepted" });
            }
          });
          break;
        }

        // ── CHUNK: encrypted binary chunk ─────────────────────────────────────
        case TcpFrameType.CHUNK: {
          if (!metadata || !sessionKey) break;

          // Binary CHUNK payload layout: [12-byte IV][16-byte authTag][ciphertext]
          // We don't decrypt here — raw chunks are stored and decrypted in batch
          // by assembleChunks() after the DONE frame arrives, because decryption
          // is CPU-bound and doing it per-chunk on the hot path would stall the
          // event loop for large files.
          if (payload.length < 28) {
            console.error("[TCP Server] CHUNK payload too short — malformed frame");
            break;
          }
          const iv = payload.subarray(0, 12);
          const authTag = payload.subarray(12, 28);
          const ciphertext = payload.subarray(28);

          // SEC-01: running size guard — catches a sender that lies about fileSize
          // in METADATA and then sends more bytes than declared.
          bytesReceived += payload.length;
          if (bytesReceived > MAX_FILE_SIZE) {
            console.warn("[TCP Server] Exceeded MAX_FILE_SIZE mid-transfer — aborting");
            onUpdate({
              id: metadata.transferId,
              peerId: socket.remoteAddress ?? "",
              peerName: socket.remoteAddress ?? "",
              direction: "receive",
              fileName: metadata.fileName,
              fileSize: metadata.fileSize,
              totalChunks: metadata.totalChunks,
              chunksReceived: receivedChunks.length,
              state: "error",
              errorMessage: "File exceeded maximum allowed size",
            });
            socket.destroy();
            return;
          }

          // Store raw encrypted chunk.  The empty hash string is intentional —
          // the chunk hash in assembler.ts is used for LAN mode where it is
          // separately computed; for direct TCP receive we rely on AES-GCM auth tag.
          receivedChunks.push({
            transferId: metadata.transferId,
            index: receivedChunks.length,
            total: metadata.totalChunks,
            data: ciphertext,
            hash: "",
            iv,
            authTag,
          });

          // Update the browser's progress bar every chunk.
          // This produces a lot of WS messages for large files — a future
          // improvement would throttle this to every N chunks.
          onUpdate({
            id: metadata.transferId,
            peerId: socket.remoteAddress ?? "",
            peerName: socket.remoteAddress ?? "",
            direction: "receive",
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            totalChunks: metadata.totalChunks,
            chunksReceived: receivedChunks.length,
            state: "transferring",
          });
          break;
        }

        // ── DONE: transfer complete, includes full-file hash ───────────────────
        case TcpFrameType.DONE: {
          if (!metadata || !sessionKey) break;

          // Disable the 30 s inactivity timer — we've received all data
          socket.setTimeout(0);

          let parsed: { kind: string; transferId: string; fileHash: string };
          try {
            parsed = JSON.parse(payload.toString("utf8"));
          } catch {
            console.error("[TCP Server] Bad DONE JSON");
            socket.destroy();
            return;
          }

          // Decrypt and verify all chunks.  assembleChunks() handles:
          //  - AES-GCM auth tag verification (per chunk)
          //  - Plaintext hash verification (per chunk)
          //  - Full-file SHA-256 verification (assembled file vs parsed.fileHash)
          const result = assembleChunks(
            receivedChunks,
            sessionKey,
            parsed.fileHash,
          );

          const transfer: Transfer = {
            id: metadata.transferId,
            peerId: socket.remoteAddress ?? "",
            peerName: socket.remoteAddress ?? "",
            direction: "receive",
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            totalChunks: metadata.totalChunks,
            chunksReceived: receivedChunks.length,
            state: result.ok ? "completed" : "error",
            errorMessage: result.ok ? undefined : result.error.message,
            completedAt: Date.now(),
          };

          if (result.ok) {
            // SEC-04 + SEC-05: async file write with atomic rename.
            //
            // Why write to a .nexdrop-tmp file first?
            // If the process crashes mid-write, the destination path contains
            // a partial file.  With atomic rename: either the rename succeeds
            // (complete file visible) or it hasn't happened yet (tmp file exists
            // but final path is absent).  The OS guarantees rename() is atomic
            // on the same filesystem.
            //
            // Why async (fs.promises) instead of sync?
            // Writing synchronously would block the Node.js event loop for the
            // duration of the disk write — potentially hundreds of milliseconds
            // for a large file — preventing other sockets from processing frames
            // (SEC-04).
            const outPath = path.join(DOWNLOAD_DIR, metadata.fileName);
            const tmpPath = outPath + ".nexdrop-tmp";
            try {
              // recursive: true makes mkdir a no-op if the directory already exists
              await fs.promises.mkdir(DOWNLOAD_DIR, { recursive: true });
              await fs.promises.writeFile(tmpPath, result.file);
              await fs.promises.rename(tmpPath, outPath);
              console.log(`[TCP Server] File saved: ${outPath}`);
            } catch (writeErr) {
              const msg =
                writeErr instanceof Error ? writeErr.message : String(writeErr);
              console.error("[TCP Server] Write failed:", msg);
              // Best-effort: remove the tmp file so it doesn't linger on disk.
              // The .catch(() => undefined) prevents an unlink failure from
              // masking the original write error.
              await fs.promises.unlink(tmpPath).catch(() => undefined);
              transfer.state = "error";
              transfer.errorMessage = `Write failed: ${msg}`;
            }
          } else {
            console.error("[TCP Server] Assembly failed:", result.error.message);
          }

          onUpdate(transfer);
          // Graceful close — sends FIN; sender receives it and also closes
          socket.end();
          break;
        }

        default:
          // Unknown frame types are logged and ignored rather than closing the
          // connection, to allow future protocol extensions to add new frame types
          // without breaking older receivers.
          console.warn(
            `[TCP Server] Unknown frame type: 0x${typeByte.toString(16)}`,
          );
      }
    }

    socket.on("error", (err) => {
      console.error("[TCP Server] Socket error:", err.message);
    });

    socket.on("close", () => {
      // Always decrement the per-IP counter, even if the socket was destroyed
      // early (e.g. rejected by per-IP limit or an error)
      untrackIp(remoteIp);
      console.log("[TCP Server] Connection closed from", remoteIp);
    });
  });

  // LOAD-01: Node enforces this at the OS accept() level — connections beyond
  // this cap are queued by the kernel backlog and refused without the server
  // having to read from them.
  server.maxConnections = TCP_MAX_CONNECTIONS;

  server.listen(TCP_PORT, () => {
    console.log(
      `[TCP Server] Listening on port ${TCP_PORT} (max ${TCP_MAX_CONNECTIONS} connections, ${TCP_MAX_CONN_PER_IP}/IP)`,
    );
  });

  return server;
}
