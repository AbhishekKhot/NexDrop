/**
 * tcpServer.ts
 * TCP server — receives incoming file transfers from LAN peers.
 *
 * Protocol (per connection):
 *  1. Receiver sends: ACCEPT <transferId> (after user accepts in UI)
 *  2. Sender sends:   METADATA frame (FileMetadata JSON + newline delimiter)
 *  3. UI is notified → user shown incoming transfer modal
 *  4. Sender sends:   CHUNK frames (one per chunk, length-prefixed)
 *  5. Sender sends:   DONE frame with full file hash
 *  6. Receiver verifies, assembles, writes file to disk
 *
 * SECURITY:
 *  - Each chunk is AES-256-GCM encrypted by the sender.
 *  - GCM auth tag checked during decryption — any tampering throws.
 *  - SHA-256 per-chunk + full-file hash verified after assembly.
 */

import net from "net";
import fs from "fs";
import path from "path";
import { TCP_PORT, DOWNLOAD_DIR } from "../config";
import type { TcpFrame, FileMetadata, Chunk, Transfer } from "../types";
import { computeSessionKey, generateECDHPair } from "../crypto/aesGcm";
import { assembleChunks } from "../chunking/assembler";

export type TransferUpdateCallback = (transfer: Transfer) => void;
export type IncomingOfferCallback = (transfer: Transfer) => void;

/**
 * Waits asynchronously for the user to accept or reject a transfer.
 * Returns a promise that resolves to true if accepted, false if rejected.
 */
export class PendingDecisionMap {
  private map = new Map<string, { resolve: (accepted: boolean) => void }>();

  register(transferId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // Auto-timeout after 60s if user doesn't respond
      const timer = setTimeout(() => {
        this.map.delete(transferId);
        resolve(false);
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

  respond(transferId: string, accepted: boolean): void {
    this.map.get(transferId)?.resolve(accepted);
  }
}

export function createTcpServer(
  pendingDecisions: PendingDecisionMap,
  onOffer: IncomingOfferCallback,
  onUpdate: TransferUpdateCallback,
): net.Server {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const server = net.createServer((socket) => {
    console.log(
      `[TCP Server] Connection from ${socket.remoteAddress}:${socket.remotePort}`,
    );

    let buffer = Buffer.alloc(0);
    let metadata: FileMetadata | null = null;
    let receivedChunks: Chunk[] = [];
    let sessionKey: Buffer | null = null;
    let transferId: string | null = null;

    // Our ephemeral ECDH key pair for this connection
    const myEcdh = generateECDHPair();

    // Send our public key first so the sender can derive the shared session key
    socket.write(
      JSON.stringify({ kind: "PUBLIC_KEY", publicKey: myEcdh.publicKeyHex }) +
        "\n",
    );

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Parse newline-delimited JSON frames
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.subarray(0, newlineIdx).toString("utf8");
        buffer = buffer.subarray(newlineIdx + 1);

        let frame: TcpFrame;
        try {
          frame = JSON.parse(line) as TcpFrame;
        } catch {
          console.error("[TCP Server] Failed to parse frame:", line);
          continue;
        }

        handleFrame(frame);
      }
    });

    function handleFrame(frame: TcpFrame) {
      switch (frame.kind) {
        case "METADATA": {
          metadata = frame.payload;
          transferId = metadata.transferId;

          // Derive session key from sender's public key
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

          onOffer(transfer);

          // Wait for user's decision
          pendingDecisions.register(transferId).then((accepted) => {
            if (!accepted) {
              socket.write(
                JSON.stringify({ kind: "REJECT", transferId }) + "\n",
              );
              socket.destroy();
              onUpdate({ ...transfer, state: "rejected" });
            } else {
              socket.write(
                JSON.stringify({ kind: "ACCEPT", transferId }) + "\n",
              );
              onUpdate({ ...transfer, state: "accepted" });
            }
          });
          break;
        }

        case "CHUNK": {
          if (!metadata || !sessionKey) break;
          const p = frame.payload;
          receivedChunks.push({
            transferId: p.transferId,
            index: p.index,
            total: p.total,
            data: Buffer.from(p.data, "base64"),
            hash: p.hash,
            iv: Buffer.from(p.iv, "base64"),
            authTag: Buffer.from(p.authTag, "base64"),
          });

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

        case "DONE": {
          if (!metadata || !sessionKey) break;

          const result = assembleChunks(
            receivedChunks,
            sessionKey,
            frame.fileHash,
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
            const outPath = path.join(DOWNLOAD_DIR, metadata.fileName);
            fs.writeFileSync(outPath, result.file);
            console.log(`[TCP Server] File saved: ${outPath}`);
          } else {
            console.error(
              "[TCP Server] Assembly failed:",
              result.error.message,
            );
          }

          onUpdate(transfer);
          socket.end();
          break;
        }
      }
    }

    socket.on("error", (err) => {
      console.error("[TCP Server] Socket error:", err.message);
    });

    socket.on("close", () => {
      console.log("[TCP Server] Connection closed");
    });
  });

  server.listen(TCP_PORT, () => {
    console.log(`[TCP Server] Listening on port ${TCP_PORT}`);
  });

  return server;
}
