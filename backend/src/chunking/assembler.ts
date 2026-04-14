/**
 * assembler.ts
 * Reassemble received encrypted chunks back into a file.
 *
 * Guarantees:
 *  1. All chunks must arrive (no gaps).
 *  2. Each chunk's AES-GCM auth tag is verified on decryption (tamper-proof).
 *  3. Each plaintext chunk's SHA-256 hash is re-checked after decryption.
 *  4. The full assembled file SHA-256 hash is compared against the sender's FileMetadata.
 *
 * If any verification step fails, the transfer is aborted and the partial file discarded.
 */

import crypto from "crypto";
import { decrypt } from "../crypto/aesGcm";
import type { Chunk } from "../types";

export interface AssemblyError {
  kind: "auth_tag_fail" | "hash_mismatch" | "incomplete" | "file_hash_mismatch";
  chunkIndex?: number;
  message: string;
}

export type AssemblyResult =
  | { ok: true; file: Buffer }
  | { ok: false; error: AssemblyError };

/**
 * Reassemble and verify a list of received chunks.
 *
 * @param chunks      All chunks for this transfer (any order — will be sorted)
 * @param sessionKey  32-byte AES key shared with sender
 * @param expectedFileHash SHA-256 hex of the full plaintext file (from FileMetadata)
 */
export function assembleChunks(
  chunks: Chunk[],
  sessionKey: Buffer,
  expectedFileHash: string,
): AssemblyResult {
  // Sort by index to handle out-of-order arrival
  const sorted = [...chunks].sort((a, b) => a.index - b.index);

  // Validate completeness
  if (sorted.length !== sorted[0]?.total) {
    return {
      ok: false,
      error: {
        kind: "incomplete",
        message: `Expected ${sorted[0]?.total} chunks, got ${sorted.length}`,
      },
    };
  }

  const plaintextParts: Buffer[] = [];

  for (const chunk of sorted) {
    // 1. Decrypt (auth tag verified by AES-GCM — throws if tampered)
    let plaintext: Buffer;
    try {
      plaintext = decrypt(sessionKey, chunk.data, chunk.iv, chunk.authTag);
    } catch {
      return {
        ok: false,
        error: {
          kind: "auth_tag_fail",
          chunkIndex: chunk.index,
          message: `AES-GCM auth tag verification failed for chunk ${chunk.index} — data may have been tampered with`,
        },
      };
    }

    // 2. Verify plaintext SHA-256 hash matches what the sender computed before encrypting
    const actualHash = crypto
      .createHash("sha256")
      .update(plaintext)
      .digest("hex");
    if (actualHash !== chunk.hash) {
      return {
        ok: false,
        error: {
          kind: "hash_mismatch",
          chunkIndex: chunk.index,
          message: `Chunk ${chunk.index} hash mismatch: expected ${chunk.hash}, got ${actualHash}`,
        },
      };
    }

    plaintextParts.push(plaintext);
  }

  // 3. Assemble full file
  const fileBuffer = Buffer.concat(plaintextParts);

  // 4. Verify full file hash
  const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  if (fileHash !== expectedFileHash) {
    return {
      ok: false,
      error: {
        kind: "file_hash_mismatch",
        message: `Full file hash mismatch: expected ${expectedFileHash}, got ${fileHash}`,
      },
    };
  }

  return { ok: true, file: fileBuffer };
}
