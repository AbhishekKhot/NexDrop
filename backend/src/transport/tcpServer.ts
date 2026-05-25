import net from "net";
import fs from "fs";
import path from "path";
import {
  TCP_PORT,
  DOWNLOAD_DIR,
  MAX_FILE_SIZE,
  TCP_MAX_CONNECTIONS,
  TCP_MAX_CONN_PER_IP,
  CHUNK_SIZE,
} from "../config";
import type { FileMetadata, Chunk, Transfer } from "../types";
import { TcpFrameType, PROTOCOL_VERSION } from "../types";
import { computeSessionKey, generateECDHPair } from "../crypto/aesGcm";
import { assembleChunks } from "../chunking/assembler";

// Hard upper bound on a frame's declared payload length. 1024 bytes of slack
// over CHUNK_SIZE+IV+tag accommodates overhead while blocking a malicious peer
// from forcing a gigabyte allocation via a giant declared length.
const MAX_FRAME_PAYLOAD_BYTES = CHUNK_SIZE + 1024;
// Tighter cap for JSON control frames — none of the legitimate control payloads
// (PUBLIC_KEY, METADATA, DONE, ACCEPT, REJECT) come close to 64 KB.
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

// Caps on advisory peer-identity fields carried in METADATA. The sender controls
// these (no auth in NexDrop by design), so the receiver must validate type +
// length + content before letting them reach the UI or logs.
const MAX_DEVICE_NAME_LEN = 64;
const MAX_DEVICE_ID_LEN = 128;

/**
 * Sanitize a peer-claimed display name for safe use in logs and UI. Strips
 * ASCII/Unicode control chars (line breaks, NULL, terminal escapes), trims
 * whitespace, and enforces a length cap. Returns undefined if the input
 * is not a usable string after cleaning.
 */
function sanitizePeerName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Cap length BEFORE the regex pass to bound work on a hostile input. The
  // regex has no nested quantifiers or backreferences, so it runs in linear
  // time regardless. Escape sequences are used (not literal control chars)
  // so the source file round-trips through editors and patches safely.
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
  const cleaned = raw.slice(0, MAX_DEVICE_NAME_LEN * 4).replace(CONTROL_CHARS, "").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_DEVICE_NAME_LEN);
}

/**
 * Validate a peer-claimed deviceId. We don't enforce UUID shape (frontend may
 * evolve the format) but we do enforce a printable-ASCII allow-list and a
 * length cap, so a malicious sender can't smuggle arbitrary bytes into our
 * internal identifiers.
 */
function sanitizeDeviceId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > MAX_DEVICE_ID_LEN) return undefined;
  if (!/^[A-Za-z0-9_.:-]+$/.test(raw)) return undefined;
  return raw;
}

export type TransferUpdateCallback = (transfer: Transfer) => void;
export type IncomingOfferCallback = (transfer: Transfer) => void;

/**
 * Bridges the async gap between an incoming METADATA frame (server must pause)
 * and the user's accept/reject click in the browser UI. Auto-rejects after 60s
 * so the sender's socket isn't held open indefinitely.
 */
export class PendingDecisionMap {
  private map = new Map<string, { resolve: (accepted: boolean) => void }>();

  register(transferId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.map.delete(transferId);
        resolve(false);
      }, 60_000);

      this.map.set(transferId, {
        resolve: (accepted: boolean) => {
          // Cleared on user response — avoids a spurious rejection arriving
          // after the user already clicked Accept.
          clearTimeout(timer);
          this.map.delete(transferId);
          resolve(accepted);
        },
      });
    });
  }

  respond(transferId: string, accepted: boolean): void {
    this.map.get(transferId)?.resolve(accepted);
  }
}

// Module-level (not closure) so the count persists across simultaneous connections.
// Per-IP cap is necessary in addition to server.maxConnections: without it a single
// host could hold all global slots and deny service to every other peer.
const ipConnections = new Map<string, number>();

function trackIp(ip: string): boolean {
  const count = ipConnections.get(ip) ?? 0;
  if (count >= TCP_MAX_CONN_PER_IP) return false;
  ipConnections.set(ip, count + 1);
  return true;
}

function untrackIp(ip: string): void {
  const count = ipConnections.get(ip) ?? 1;
  // Delete the entry entirely at zero to avoid unbounded Map growth
  if (count <= 1) ipConnections.delete(ip);
  else ipConnections.set(ip, count - 1);
}

// Single socket.write() with concatenated Buffer keeps header and payload in one
// TCP segment, avoiding a Nagle-algorithm delay where the kernel might hold a
// small header until more data arrives.
function writeControlFrame(
  socket: net.Socket,
  typeByte: number,
  payload: object,
): void {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(typeByte, 0);
  header.writeUInt32BE(json.length, 1);
  socket.write(Buffer.concat([header, json]));
}

export function createTcpServer(
  pendingDecisions: PendingDecisionMap,
  onOffer: IncomingOfferCallback,
  onUpdate: TransferUpdateCallback,
): net.Server {
  const server = net.createServer((socket) => {
    const remoteIp = socket.remoteAddress ?? "unknown";

    // Per-IP check before reading data — cheaper than reading METADATA and rejecting.
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

    // 30s inactivity timeout — Node resets the timer on every 'data' event so
    // legitimate slow senders won't trigger it. Without this, a stalled sender
    // would hold the socket open indefinitely, leaking FDs and the per-IP slot.
    socket.setTimeout(30_000);
    socket.on("timeout", () => {
      console.warn(`[TCP Server] Inactivity timeout from ${remoteIp} — closing`);
      if (metadata && transferId) {
        onUpdate({
          id: transferId,
          peerId: peerDisplayId,
          peerName: peerDisplayName,
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

    // readBuf accumulates incoming TCP data; frames parse out as complete
    // header+payload sequences arrive. Multiple frames may arrive in one
    // 'data' event; a single frame may span multiple events.
    let readBuf = Buffer.alloc(0);

    let metadata: FileMetadata | null = null;
    let receivedChunks: Chunk[] = [];
    let sessionKey: Buffer | null = null;
    let transferId: string | null = null;
    let bytesReceived = 0;
    // Cached after METADATA passes sanitisation; reused on every transfer_update
    // so the UI sees a consistent peer identity throughout the transfer.
    let peerDisplayId: string = remoteIp;
    let peerDisplayName: string = remoteIp;

    const myEcdh = generateECDHPair();
    writeControlFrame(socket, TcpFrameType.PUBLIC_KEY, {
      kind: "PUBLIC_KEY",
      publicKey: myEcdh.publicKeyHex,
    });

    socket.on("data", (incoming) => {
      readBuf = Buffer.concat([readBuf, incoming]);
      parseFrames();
    });

    function parseFrames(): void {
      while (readBuf.length >= 5) {
        const typeByte = readBuf.readUInt8(0);
        const payloadLen = readBuf.readUInt32BE(1);

        // Enforce per-frame size cap BEFORE waiting for the payload. Without
        // this, a malicious peer declaring payloadLen = 4 GB would force readBuf
        // to grow to that size as more 'data' events arrive, exhausting memory
        // long before any application-level size check runs.
        if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
          console.warn(
            `[TCP Server] Frame payload too large (${payloadLen} bytes > ${MAX_FRAME_PAYLOAD_BYTES}) — closing connection from ${remoteIp}`,
          );
          socket.destroy();
          return;
        }
        if (
          typeByte !== TcpFrameType.CHUNK &&
          payloadLen > MAX_CONTROL_FRAME_BYTES
        ) {
          console.warn(
            `[TCP Server] Control frame too large (type=0x${typeByte.toString(16)}, ${payloadLen} bytes) — closing connection from ${remoteIp}`,
          );
          socket.destroy();
          return;
        }

        if (readBuf.length < 5 + payloadLen) break;

        const payload = readBuf.subarray(5, 5 + payloadLen);
        readBuf = readBuf.subarray(5 + payloadLen);

        // handleFrame is async (disk I/O in DONE handler); .catch() destroys the
        // socket rather than letting an unhandled rejection silently fail.
        handleFrame(typeByte, payload).catch((err) => {
          console.error("[TCP Server] Frame handler error:", err);
          socket.destroy();
        });
      }
    }

    async function handleFrame(
      typeByte: number,
      payload: Buffer,
    ): Promise<void> {
      switch (typeByte) {
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

          // Reject mismatched protocol versions explicitly so incompatible
          // framing/crypto changes fail loudly here rather than silently
          // corrupting data by reinterpreting unknown frame layouts.
          if (
            typeof metadata.protocolVersion !== "number" ||
            metadata.protocolVersion !== PROTOCOL_VERSION
          ) {
            console.warn(
              `[TCP Server] Protocol version mismatch from ${remoteIp}: peer=${metadata.protocolVersion}, ours=${PROTOCOL_VERSION}`,
            );
            writeControlFrame(socket, TcpFrameType.REJECT, {
              kind: "REJECT",
              transferId,
            });
            socket.destroy();
            return;
          }

          // Reject oversized files at METADATA (not DONE) — avoids receiving
          // chunks for a file we'll reject.
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

          sessionKey = computeSessionKey(myEcdh.ecdh, metadata.senderPublicKey);

          // Validated peer identity falls back to the connecting IP when the
          // sender omits or malforms the advisory fields. Names are advisory
          // only — there is no authentication of identity in NexDrop.
          peerDisplayName =
            sanitizePeerName(metadata.senderDeviceName) ?? remoteIp;
          peerDisplayId =
            sanitizeDeviceId(metadata.senderDeviceId) ?? remoteIp;

          const transfer: Transfer = {
            id: transferId,
            peerId: peerDisplayId,
            peerName: peerDisplayName,
            direction: "receive",
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            totalChunks: metadata.totalChunks,
            chunksReceived: 0,
            state: "pending",
            startedAt: Date.now(),
          };

          onOffer(transfer);

          // Connection stays open and keeps accumulating data events while
          // waiting; in practice the sender waits for ACCEPT/REJECT before
          // streaming chunks.
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

        case TcpFrameType.CHUNK: {
          if (!metadata || !sessionKey) break;

          // Binary CHUNK payload: [12-byte IV][16-byte authTag][ciphertext].
          // We don't decrypt here — raw chunks are stored and decrypted in batch
          // by assembleChunks() after DONE, because per-chunk decryption on the
          // hot path would stall the event loop for large files.
          if (payload.length < 28) {
            console.error("[TCP Server] CHUNK payload too short — malformed frame");
            break;
          }
          const iv = payload.subarray(0, 12);
          const authTag = payload.subarray(12, 28);
          const ciphertext = payload.subarray(28);

          // Running size guard — catches a sender that lies about fileSize in
          // METADATA and then sends more bytes than declared.
          bytesReceived += payload.length;
          if (bytesReceived > MAX_FILE_SIZE) {
            console.warn("[TCP Server] Exceeded MAX_FILE_SIZE mid-transfer — aborting");
            onUpdate({
              id: metadata.transferId,
              peerId: peerDisplayId,
              peerName: peerDisplayName,
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

          // Empty hash string is intentional — the chunk hash is used for LAN
          // mode where it's separately computed; for direct TCP receive we rely
          // on the AES-GCM auth tag.
          receivedChunks.push({
            transferId: metadata.transferId,
            index: receivedChunks.length,
            total: metadata.totalChunks,
            data: ciphertext,
            hash: "",
            iv,
            authTag,
          });

          onUpdate({
            id: metadata.transferId,
            peerId: peerDisplayId,
            peerName: peerDisplayName,
            direction: "receive",
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            totalChunks: metadata.totalChunks,
            chunksReceived: receivedChunks.length,
            state: "transferring",
          });
          break;
        }

        case TcpFrameType.DONE: {
          if (!metadata || !sessionKey) break;

          socket.setTimeout(0);

          let parsed: { kind: string; transferId: string; fileHash: string };
          try {
            parsed = JSON.parse(payload.toString("utf8"));
          } catch {
            console.error("[TCP Server] Bad DONE JSON");
            socket.destroy();
            return;
          }

          // assembleChunks() verifies AES-GCM auth tag per chunk, plaintext hash
          // per chunk, and full-file SHA-256 vs parsed.fileHash.
          const result = assembleChunks(
            receivedChunks,
            sessionKey,
            parsed.fileHash,
          );

          const transfer: Transfer = {
            id: metadata.transferId,
            peerId: peerDisplayId,
            peerName: peerDisplayName,
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
            // Atomic write: write to .nexdrop-tmp first then rename. If the
            // process crashes mid-write, the destination path doesn't contain
            // a partial file — rename is atomic on the same filesystem.
            // Async fs.promises (not sync) to avoid blocking the event loop
            // for the duration of the disk write.
            const outPath = path.join(DOWNLOAD_DIR, metadata.fileName);
            const tmpPath = outPath + ".nexdrop-tmp";
            try {
              await fs.promises.mkdir(DOWNLOAD_DIR, { recursive: true });
              await fs.promises.writeFile(tmpPath, result.file);
              await fs.promises.rename(tmpPath, outPath);
              console.log(`[TCP Server] File saved: ${outPath}`);
            } catch (writeErr) {
              const msg =
                writeErr instanceof Error ? writeErr.message : String(writeErr);
              console.error("[TCP Server] Write failed:", msg);
              // Best-effort unlink; .catch(() => undefined) prevents an unlink
              // failure from masking the original write error.
              await fs.promises.unlink(tmpPath).catch(() => undefined);
              transfer.state = "error";
              transfer.errorMessage = `Write failed: ${msg}`;
            }
          } else {
            console.error("[TCP Server] Assembly failed:", result.error.message);
          }

          onUpdate(transfer);
          socket.end();
          break;
        }

        default:
          // Unknown frame types are logged and ignored (rather than closing) to
          // allow future protocol extensions without breaking older receivers.
          console.warn(
            `[TCP Server] Unknown frame type: 0x${typeByte.toString(16)}`,
          );
      }
    }

    socket.on("error", (err) => {
      console.error("[TCP Server] Socket error:", err.message);
    });

    socket.on("close", () => {
      // Always decrement, even if the socket was destroyed early
      untrackIp(remoteIp);
      console.log("[TCP Server] Connection closed from", remoteIp);
    });
  });

  // Node enforces this at the OS accept() level — excess connections are queued
  // by the kernel backlog and refused without the server having to read from them.
  server.maxConnections = TCP_MAX_CONNECTIONS;

  server.listen(TCP_PORT, () => {
    console.log(
      `[TCP Server] Listening on port ${TCP_PORT} (max ${TCP_MAX_CONNECTIONS} connections, ${TCP_MAX_CONN_PER_IP}/IP)`,
    );
  });

  return server;
}
