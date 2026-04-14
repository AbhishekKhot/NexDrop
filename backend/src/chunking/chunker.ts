/**
 * chunker.ts
 * Split a file (Buffer) into encrypted, integrity-verified chunks.
 *
 * This module is the core of the transfer pipeline and is shared between:
 *  - LAN mode: chunks sent over TCP sockets
 *  - Remote mode: chunks sent over WebRTC DataChannels (future phase)
 *
 * Each chunk carries:
 *  - Its own random IV (12 bytes) → no IV reuse
 *  - AES-256-GCM auth tag → tamper-proof
 *  - SHA-256 hash of the plaintext → integrity verification after decryption
 */

import crypto from "crypto";
import { CHUNK_SIZE } from "../config";
import { encrypt, type ECDHPair } from "../crypto/aesGcm";
import type { Chunk } from "../types";

/**
 * Split a file buffer into encrypted chunks.
 *
 * @param transferId UUID for this transfer session
 * @param fileBuffer Full file contents as a Buffer
 * @param sessionKey 32-byte AES-256-GCM key (derived from ECDH exchange)
 * @param chunkSize  Bytes per chunk (default CHUNK_SIZE from config)
 * @returns Array of Chunk objects ready to be sent over the wire
 */
export function chunkFile(
  transferId: string,
  fileBuffer: Buffer,
  sessionKey: Buffer,
  chunkSize = CHUNK_SIZE,
): Chunk[] {
  const total = Math.ceil(fileBuffer.length / chunkSize);
  const chunks: Chunk[] = [];

  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileBuffer.length);
    const plaintext = fileBuffer.subarray(start, end);

    // Hash plaintext for integrity verification on the receiver side
    const hash = crypto.createHash("sha256").update(plaintext).digest("hex");

    // Encrypt the plaintext chunk
    const { ciphertext, iv, authTag } = encrypt(sessionKey, plaintext);

    chunks.push({
      transferId,
      index: i,
      total,
      data: ciphertext,
      hash,
      iv,
      authTag,
    });
  }

  return chunks;
}

/**
 * Compute SHA-256 hash of the entire file buffer.
 * Sent in FileMetadata so the receiver can verify the assembled file.
 */
export function hashFile(fileBuffer: Buffer): string {
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}
