import crypto from "crypto";
import { decrypt } from "../crypto/aesGcm";
import type { Chunk } from "../types";

export interface AssemblyError {
  kind:
    | "auth_tag_fail"
    | "hash_mismatch"
    | "incomplete"
    | "file_hash_mismatch";
  chunkIndex?: number;
  message: string;
}

export type AssemblyResult =
  | { ok: true; file: Buffer }
  | { ok: false; error: AssemblyError };

// Chunks may arrive out of order over TCP; sort by index so concatenation is
// always correct regardless of delivery order.
export function assembleChunks(
  chunks: Chunk[],
  sessionKey: Buffer,
  expectedFileHash: string,
): AssemblyResult {
  const sorted = [...chunks].sort((a, b) => a.index - b.index);

  if (sorted.length === 0 || sorted.length !== sorted[0]?.total) {
    return {
      ok: false,
      error: {
        kind: "incomplete",
        message: `Expected ${sorted[0]?.total ?? "?"} chunks, got ${sorted.length}`,
      },
    };
  }

  const plaintextParts: Buffer[] = [];

  for (const chunk of sorted) {
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

    // Per-chunk plaintext hash is optional defense-in-depth. The TCP wire
    // format omits it (chunk.hash === "") and relies on the AES-GCM auth tag
    // above plus the full-file SHA-256 below. Only verify when a hash is
    // actually carried with the chunk.
    if (chunk.hash) {
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
    }

    plaintextParts.push(plaintext);
  }

  const fileBuffer = Buffer.concat(plaintextParts);
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
