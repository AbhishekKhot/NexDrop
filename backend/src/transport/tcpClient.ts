/**
 * tcpClient.ts
 * TCP client — sends a file to a LAN peer.
 *
 * Protocol (sender side):
 *  1. Connect to peer's TCP port
 *  2. Receive peer's ECDH public key → derive session key
 *  3. Send METADATA frame (FileMetadata with our ECDH public key)
 *  4. Wait for ACCEPT frame from receiver (user on other side accepted)
 *  5. Stream CHUNK frames (chunked + encrypted)
 *  6. Send DONE frame with full file hash
 *
 * Handles backpressure: waits for drain event if send buffer is full.
 */

import net from "net";
import { v4 as uuidv4 } from "uuid";
import { generateECDHPair, computeSessionKey } from "../crypto/aesGcm";
import { chunkFile, hashFile } from "../chunking/chunker";
import type { Transfer, TransferState, TcpFrame } from "../types";
import { DEVICE_NAME } from "../config";

export type TransferUpdateCallback = (transfer: Transfer) => void;

/**
 * Send a file to a LAN peer.
 *
 * @param peerIp     IP address of the recipient
 * @param peerPort   TCP port of the recipient
 * @param peerId     Peer identifier (for tracking)
 * @param peerName   Human-readable peer name
 * @param fileBuffer Full file contents as Buffer
 * @param fileName   Original file name
 * @param onUpdate   Called whenever the transfer state changes
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
  const transferId = uuidv4();
  const myEcdh = generateECDHPair();
  const fileHash = hashFile(fileBuffer);

  const transfer: Transfer = {
    id: transferId,
    peerId,
    peerName,
    direction: "send",
    fileName,
    fileSize: fileBuffer.length,
    totalChunks: 0, // filled after chunking
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

    let lineBuffer = "";
    let sessionKey: Buffer | null = null;
    let state: "waiting_key" | "waiting_accept" | "sending" | "done" =
      "waiting_key";

    socket.on("data", (data) => {
      lineBuffer += data.toString("utf8");
      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx);
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        handleLine(line);
      }
    });

    function handleLine(line: string) {
      let msg: { kind: string; publicKey?: string; transferId?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (
        state === "waiting_key" &&
        msg.kind === "PUBLIC_KEY" &&
        msg.publicKey
      ) {
        // Derive session key from receiver's public key
        sessionKey = computeSessionKey(myEcdh.ecdh, msg.publicKey);

        // Chunk the file now that we have the key
        const totalChunks = Math.ceil(fileBuffer.length / (256 * 1024));
        transfer.totalChunks = totalChunks;

        // Send METADATA
        const metadataFrame: TcpFrame = {
          kind: "METADATA",
          payload: {
            transferId,
            fileName,
            fileSize: fileBuffer.length,
            totalChunks,
            fileHash,
            senderPublicKey: myEcdh.publicKeyHex,
          },
        };
        socket.write(JSON.stringify(metadataFrame) + "\n");
        onUpdate({ ...transfer, state: "pending" });
        state = "waiting_accept";
      }

      if (
        state === "waiting_accept" &&
        msg.kind === "ACCEPT" &&
        msg.transferId === transferId
      ) {
        onUpdate({ ...transfer, state: "accepted" });
        state = "sending";
        sendChunks();
      }

      if (msg.kind === "REJECT" && msg.transferId === transferId) {
        onUpdate({ ...transfer, state: "rejected" });
        socket.destroy();
        resolve();
      }
    }

    async function sendChunks() {
      if (!sessionKey) return;

      onUpdate({ ...transfer, state: "transferring" });
      const chunks = chunkFile(transferId, fileBuffer, sessionKey);

      for (const chunk of chunks) {
        const chunkFrame: TcpFrame = {
          kind: "CHUNK",
          payload: {
            transferId: chunk.transferId,
            index: chunk.index,
            total: chunk.total,
            iv: chunk.iv.toString("base64"),
            data: chunk.data.toString("base64"),
            hash: chunk.hash,
            authTag: chunk.authTag.toString("base64"),
          },
        };
        const line = JSON.stringify(chunkFrame) + "\n";
        const canContinue = socket.write(line);
        if (!canContinue) {
          // Wait for backpressure to clear
          await new Promise<void>((r) => socket.once("drain", r));
        }

        onUpdate({
          ...transfer,
          state: "transferring",
          chunksReceived: chunk.index + 1,
        });
      }

      // Send DONE
      const doneFrame: TcpFrame = { kind: "DONE", transferId, fileHash };
      socket.write(JSON.stringify(doneFrame) + "\n");
      socket.end();

      onUpdate({ ...transfer, state: "completed", completedAt: Date.now() });
      resolve();
    }

    socket.on("error", (err) => {
      console.error("[TCP Client] Error:", err.message);
      onUpdate({ ...transfer, state: "error", errorMessage: err.message });
      reject(err);
    });

    socket.on("close", () => {
      console.log("[TCP Client] Connection closed");
    });
  });
}
