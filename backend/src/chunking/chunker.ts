/**
 * chunker.ts
 * Split a file buffer into fixed-size encrypted chunks ready for wire transport.
 *
 * This is the sender's half of the transfer pipeline.  The receiver's half is
 * assembler.ts.  Both modules must agree on the chunk structure:
 *   { index, total, data (ciphertext), iv, authTag, hash (plaintext SHA-256) }
 *
 * Encryption happens per-chunk so that:
 *  1. Each chunk has its own random IV — no IV reuse even for huge files.
 *  2. The receiver can verify each chunk independently in the assembler
 *     without waiting for the whole file.
 *  3. A dropped or corrupted chunk can be pinpointed by index rather than
 *     requiring a full retransmit.
 *
 * The plaintext SHA-256 hash (chunk.hash) is computed before encryption and
 * verified by the assembler after decryption.  This double-checks that AES-GCM
 * decryption produced the correct plaintext, not just that the ciphertext wasn't
 * tampered with in transit.
 */

import crypto from "crypto";
import { CHUNK_SIZE } from "../config";
import { encrypt } from "../crypto/aesGcm";
import type { Chunk } from "../types";

/**
 * Split a file buffer into encrypted, integrity-verified chunks.
 *
 * The last chunk is typically smaller than chunkSize — its actual byte length
 * is embedded in the chunk's data length, and the receiver reconstructs the
 * correct file size by concatenating decrypted chunks in order.
 *
 * @param transferId  UUID for this transfer session — stored in each Chunk for
 *                    logging and association on the receiver side.
 * @param fileBuffer  Full file contents read into memory by the caller.
 *                    NOTE: loading the entire file into memory is appropriate
 *                    for the current 2 GB limit; for larger files, chunking
 *                    should stream from disk instead.
 * @param sessionKey  32-byte AES-256-GCM key derived from the ECDH handshake.
 * @param chunkSize   Slice size in bytes; defaults to the global CHUNK_SIZE (256 KB).
 *                    Overridable for testing or future negotiation.
 * @returns           Array of Chunk objects in ascending index order.
 */
export function chunkFile(
  transferId: string,
  fileBuffer: Buffer,
  sessionKey: Buffer,
  chunkSize = CHUNK_SIZE,
): Chunk[] {
  // Math.ceil handles the case where fileBuffer.length % chunkSize !== 0
  // so the final partial chunk is always included
  const total = Math.ceil(fileBuffer.length / chunkSize);
  const chunks: Chunk[] = [];

  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    // Math.min prevents the last slice from going past the buffer end
    const end = Math.min(start + chunkSize, fileBuffer.length);
    // subarray() returns a view — no data copy, important for memory efficiency
    const plaintext = fileBuffer.subarray(start, end);

    // Hash the plaintext slice BEFORE encrypting.
    // The receiver will verify this hash after decryption.
    // Hashing plaintext (not ciphertext) is intentional — it gives a second
    // independent integrity check beyond AES-GCM's auth tag.
    const hash = crypto.createHash("sha256").update(plaintext).digest("hex");

    // encrypt() generates a fresh 12-byte random IV for every chunk
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
 * Compute SHA-256 of the full file buffer.
 *
 * This hash is embedded in the DONE frame and used by the receiver to verify
 * the assembled file once all chunks are decrypted and concatenated.  It
 * provides a final end-to-end integrity guarantee on top of the per-chunk
 * auth tags and hashes, catching any reassembly-order bugs.
 *
 * @param fileBuffer  The complete plaintext file contents.
 * @returns           Lowercase hex digest string.
 */
export function hashFile(fileBuffer: Buffer): string {
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}
