import net from "net";
import { v4 as uuidv4 } from "uuid";
import { generateECDHPair, computeSessionKey } from "../crypto/aesGcm";
import { chunkFile, hashFile } from "../chunking/chunker";
import type { Transfer, TcpControlFrame } from "../types";
import { TcpFrameType, PROTOCOL_VERSION } from "../types";
import { CHUNK_SIZE, MAX_FILE_SIZE, MAX_TRANSFER_BPS } from "../config";

// Server → client frames are always control frames (PUBLIC_KEY, ACCEPT, REJECT) —
// none should exceed 64 KB. A larger declared length is hostile.
const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

export type TransferUpdateCallback = (transfer: Transfer) => void;

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

// Binary CHUNK frame: [1-byte type][4-byte length][12-byte IV][16-byte tag][ciphertext].
// IV and authTag inlined into the payload at fixed offsets (0..11, 12..27, 28..)
// to avoid extra JSON parsing on the hot path. Mirrored in tcpServer.ts.
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

/**
 * Token-bucket rate limiter — chosen over a fixed sleep because token bucket
 * naturally handles bursts (accumulated tokens let the next chunk send without
 * waiting) and the refill calculation accounts for actual time elapsed so drift
 * doesn't build up. If tokens < bytes we sleep the exact wait duration rather
 * than spinning.
 */
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
    // Cap at one bucket's worth to prevent token hoarding after idle periods
    this.tokens = Math.min(this.bytesPerSec, this.tokens + elapsed * this.bytesPerSec);
    this.lastRefill = now;

    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return;
    }

    const needed = bytes - this.tokens;
    const waitMs = Math.ceil((needed / this.bytesPerSec) * 1000);
    this.tokens = 0;
    await new Promise<void>((r) => setTimeout(r, waitMs));
  }
}

// Returns null on parse failure rather than throwing, so callers can handle
// malformed frames by logging and ignoring instead of crashing.
function parseControlFrame(data: Buffer): TcpControlFrame | null {
  try {
    return JSON.parse(data.toString("utf8")) as TcpControlFrame;
  } catch {
    return null;
  }
}

export async function sendFileToPeer(
  peerIp: string,
  peerPort: number,
  peerId: string,
  peerName: string,
  fileBuffer: Buffer,
  fileName: string,
  onUpdate: TransferUpdateCallback,
): Promise<void> {
  // Reject oversized files before opening any socket — avoids wasting the peer's
  // connection slot and our own FD on a transfer we'll reject immediately.
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

    let readBuf = Buffer.alloc(0);

    let state: "waiting_key" | "waiting_accept" | "sending" | "done" =
      "waiting_key";

    socket.on("data", (data) => {
      readBuf = Buffer.concat([readBuf, data]);

      while (readBuf.length >= 5) {
        const typeByte = readBuf.readUInt8(0);
        const payloadLen = readBuf.readUInt32BE(1);

        if (payloadLen > MAX_CONTROL_FRAME_BYTES) {
          console.warn(
            `[TCP Client] Server frame too large (type=0x${typeByte.toString(16)}, ${payloadLen} bytes) — closing connection`,
          );
          socket.destroy();
          return;
        }

        if (readBuf.length < 5 + payloadLen) break;

        const payload = readBuf.subarray(5, 5 + payloadLen);
        readBuf = readBuf.subarray(5 + payloadLen);

        handleFrame(typeByte, payload);
      }
    });

    // State guard on each case prevents out-of-order frames from causing
    // unexpected behaviour (e.g. an ACCEPT before METADATA is sent is ignored).
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

        // Stash sessionKey on the socket so it's accessible in the ACCEPT
        // handler without a closure variable that would need careful management
        // across the async sendChunks() call.
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
        // Not awaited — runs concurrently with the data event handler. Safe
        // because we're now in "sending" state and no more frames are expected
        // from the peer until the transfer completes.
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

    // Backpressure: writeChunkFrame() returns false when the kernel send buffer
    // is full — await 'drain' before continuing so we don't accumulate unbounded
    // data in Node's JS heap.
    async function sendChunks(sessionKey: Buffer): Promise<void> {
      onUpdate({ ...transfer, state: "transferring" });
      // chunkFile() encrypts every slice with a fresh IV — synchronous CPU work.
      // At 256 KB chunks it's fast enough on the event loop; for much larger
      // files this could be moved to a worker thread.
      const chunks = chunkFile(transferId, fileBuffer, sessionKey);

      for (const chunk of chunks) {
        if (rateLimiter) {
          await rateLimiter.consume(chunk.data.length);
        }

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
      // Resolve (not reject) on unexpected close before "done" — the transfer
      // update above already marked the state as error if needed.
      if (state !== "done") resolve();
    });
  });
}
