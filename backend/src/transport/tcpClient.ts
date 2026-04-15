/**
 * tcpClient.ts
 * TCP client — sends a file to a LAN peer.
 *
 * Wire protocol (CPU-02 — binary length-prefix framing):
 *  Each frame: [1-byte type][4-byte payload-length][payload bytes]
 *
 *  Control frames (PUBLIC_KEY, METADATA, DONE): JSON payload
 *  CHUNK frame: binary payload = [12-byte IV][16-byte authTag][ciphertext]
 *
 * Transfer lifecycle:
 *  1. Connect to peer's TCP port
 *  2. Receive peer's PUBLIC_KEY → derive session key
 *  3. Send METADATA (FileMetadata JSON with our ECDH public key + chunkSize)
 *  4. Wait for ACCEPT or REJECT from receiver
 *  5. Stream binary CHUNK frames (no base64 overhead)
 *  6. Send DONE with full-file SHA-256
 *
 * Fixes applied:
 *  SEC-02  — Enforce MAX_FILE_SIZE before opening socket
 *  CPU-02  — Binary length-prefix framing for CHUNK (no JSON, no base64)
 *  QUAL-04 — chunkSize included in METADATA frame
 *  LOAD-03 — Optional token-bucket rate limiting via MAX_TRANSFER_BPS
 */

import net from "net";
import { v4 as uuidv4 } from "uuid";
import { generateECDHPair, computeSessionKey } from "../crypto/aesGcm";
import { chunkFile, hashFile } from "../chunking/chunker";
import type { Transfer, TcpControlFrame } from "../types";
import { TcpFrameType, PROTOCOL_VERSION } from "../types";
import { DEVICE_NAME, CHUNK_SIZE, MAX_FILE_SIZE, MAX_TRANSFER_BPS } from "../config";

export type TransferUpdateCallback = (transfer: Transfer) => void;

// ── Frame writer helpers ──────────────────────────────────────────────────────

/** Write a JSON control frame: [1-byte type][4-byte length][JSON bytes] */
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
 * Write a binary CHUNK frame: [1-byte type][4-byte length][IV][authTag][ciphertext]
 * Returns false if the socket is experiencing backpressure.
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
  return socket.write(Buffer.concat([header, iv, authTag, ciphertext]));
}

// ── Token-bucket rate limiter (LOAD-03) ──────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private bytesPerSec: number) {
    this.tokens = bytesPerSec;
    this.lastRefill = Date.now();
  }

  async consume(bytes: number): Promise<void> {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.bytesPerSec, this.tokens + elapsed * this.bytesPerSec);
    this.lastRefill = now;

    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return;
    }

    // Need to wait for enough tokens to accumulate
    const needed = bytes - this.tokens;
    const waitMs = Math.ceil((needed / this.bytesPerSec) * 1000);
    this.tokens = 0;
    await new Promise<void>((r) => setTimeout(r, waitMs));
  }
}

// ── Frame reader helper ───────────────────────────────────────────────────────

function parseControlFrame(data: Buffer): TcpControlFrame | null {
  try {
    return JSON.parse(data.toString("utf8")) as TcpControlFrame;
  } catch {
    return null;
  }
}

// ── Main send function ────────────────────────────────────────────────────────

/**
 * Send a file to a LAN peer.
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
  // SEC-02: Reject oversized files before opening any socket
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
  const myEcdh = generateECDHPair();
  const fileHash = hashFile(fileBuffer);

  const rateLimiter = MAX_TRANSFER_BPS ? new TokenBucket(MAX_TRANSFER_BPS) : null;

  const transfer: Transfer = {
    id: transferId,
    peerId,
    peerName,
    direction: "send",
    fileName,
    fileSize: fileBuffer.length,
    totalChunks: 0,
    chunksReceived: 0,
    state: "pending",
    startedAt: Date.now(),
  };
  onUpdate(transfer);

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(
      { host: peerIp, port: peerPort },
      () => {
        console.log(
          `[TCP Client] Connected to ${peerIp}:${peerPort} for transfer ${transferId}`,
        );
      },
    );

    // Binary frame parser state
    let readBuf = Buffer.alloc(0);
    let state: "waiting_key" | "waiting_accept" | "sending" | "done" =
      "waiting_key";

    socket.on("data", (data) => {
      readBuf = Buffer.concat([readBuf, data]);

      while (readBuf.length >= 5) {
        const typeByte = readBuf.readUInt8(0);
        const payloadLen = readBuf.readUInt32BE(1);
        if (readBuf.length < 5 + payloadLen) break;

        const payload = readBuf.subarray(5, 5 + payloadLen);
        readBuf = readBuf.subarray(5 + payloadLen);

        handleFrame(typeByte, payload);
      }
    });

    function handleFrame(typeByte: number, payload: Buffer): void {
      const frame = parseControlFrame(payload);
      if (!frame) return;

      if (
        state === "waiting_key" &&
        typeByte === TcpFrameType.PUBLIC_KEY &&
        frame.kind === "PUBLIC_KEY"
      ) {
        const sessionKey = computeSessionKey(myEcdh.ecdh, frame.publicKey);
        const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);
        transfer.totalChunks = totalChunks;

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

        // Capture sessionKey in closure
        socket.once("data", () => {}); // keep closure alive
        (socket as typeof socket & { _sessionKey?: Buffer })._sessionKey =
          sessionKey;
      }

      if (
        state === "waiting_accept" &&
        typeByte === TcpFrameType.ACCEPT &&
        frame.kind === "ACCEPT" &&
        frame.transferId === transferId
      ) {
        onUpdate({ ...transfer, state: "accepted" });
        state = "sending";
        const sk = (socket as typeof socket & { _sessionKey?: Buffer })._sessionKey;
        if (sk) sendChunks(sk);
      }

      if (
        typeByte === TcpFrameType.REJECT &&
        frame.kind === "REJECT" &&
        frame.transferId === transferId
      ) {
        onUpdate({ ...transfer, state: "rejected" });
        socket.destroy();
        resolve();
      }
    }

    async function sendChunks(sessionKey: Buffer): Promise<void> {
      onUpdate({ ...transfer, state: "transferring" });
      const chunks = chunkFile(transferId, fileBuffer, sessionKey);

      for (const chunk of chunks) {
        // LOAD-03: optional rate limiting
        if (rateLimiter) {
          await rateLimiter.consume(chunk.data.length);
        }

        // CPU-02: binary CHUNK frame (no JSON, no base64)
        const canContinue = writeChunkFrame(
          socket,
          chunk.iv,
          chunk.authTag,
          chunk.data,
        );
        if (!canContinue) {
          await new Promise<void>((r) => socket.once("drain", r));
        }

        onUpdate({
          ...transfer,
          state: "transferring",
          chunksReceived: chunk.index + 1,
        });
      }

      writeControlFrame(socket, TcpFrameType.DONE, {
        kind: "DONE",
        transferId,
        fileHash,
      });
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
      if (state !== "done") resolve();
    });
  });
}
