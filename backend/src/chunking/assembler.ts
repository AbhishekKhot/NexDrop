/**
 * assembler.ts
 * Reassemble received encrypted chunks back into the original file.
 *
 * This is the receiver's half of the transfer pipeline.  The sender's half is
 * chunker.ts.  Both must agree on the chunk structure and integrity checks.
 *
 * Verification layers (all must pass):
 *  1. Completeness   — all expected chunks arrived (no gaps allowed).
 *  2. AES-GCM tag    — decryption throws if the ciphertext or IV was tampered with.
 *  3. Plaintext hash — SHA-256 of decrypted bytes must match the hash the sender
 *                      computed before encryption.  This catches subtle bugs where
 *                      decryption "succeeds" (wrong key but valid-looking tag) or
 *                      chunk ordering was corrupted.
 *  4. File hash      — SHA-256 of the assembled file must match the value in the
 *                      DONE frame.  End-to-end integrity across all chunks.
 *
 * On any failure the entire transfer is aborted and the partial file discarded —
 * returning even partially corrupt data to the user is never acceptable.
 */

import crypto from "crypto";
import { decrypt } from "../crypto/aesGcm";
import type { Chunk } from "../types";

/** Describes what went wrong during assembly — surfaced in the UI error message */
export interface AssemblyError {
  kind:
    | "auth_tag_fail"      // AES-GCM auth tag failed — ciphertext was tampered
    | "hash_mismatch"      // plaintext hash mismatch after decryption
    | "incomplete"         // fewer chunks arrived than expected
    | "file_hash_mismatch";// assembled file hash differs from sender's DONE frame
  chunkIndex?: number;     // present for per-chunk errors
  message: string;
}

/**
 * Discriminated union result — callers must check result.ok before accessing
 * result.file to ensure they only get a Buffer when all checks passed.
 */
export type AssemblyResult =
  | { ok: true; file: Buffer }
  | { ok: false; error: AssemblyError };

/**
 * Reassemble, decrypt, and verify a complete set of received chunks.
 *
 * Chunks may arrive out of order over TCP (in practice they don't, but the
 * design is order-independent for robustness).  They are sorted by index
 * before processing so concatenation always produces the correct file.
 *
 * @param chunks            All received chunks for this transfer (any order).
 * @param sessionKey        32-byte AES key shared with the sender via ECDH.
 * @param expectedFileHash  SHA-256 hex from the sender's DONE frame — the
 *                          ground truth for the full assembled file.
 */
export function assembleChunks(
  chunks: Chunk[],
  sessionKey: Buffer,
  expectedFileHash: string,
): AssemblyResult {
  // Sort ascending by index so concatenation is always correct, regardless of
  // what order the TCP layer delivered the chunks
  const sorted = [...chunks].sort((a, b) => a.index - b.index);

  // Guard against empty chunk arrays (shouldn't happen in practice, but
  // accessing sorted[0].total below would throw without this check)
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
    // ── Layer 2: AES-GCM authentication ─────────────────────────────────────
    // decrypt() throws if the auth tag doesn't verify.  This detects:
    //  - Ciphertext modification in transit
    //  - IV mismatch (wrong chunk paired with wrong header)
    //  - Key mismatch (wrong session key)
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

    // ── Layer 3: plaintext hash verification ─────────────────────────────────
    // The sender hashed the plaintext before encrypting and sent the hash in
    // the Chunk struct.  Re-computing and comparing here catches any scenario
    // where decryption produced bytes that "look valid" but are wrong
    // (e.g. a key derivation edge case producing the wrong key).
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

  // ── Layer 4: full-file hash verification ─────────────────────────────────
  // Buffer.concat produces a single contiguous buffer from the plaintext slices.
  // The SHA-256 of this assembled buffer must match the hash sent in the DONE frame.
  // This is the definitive end-to-end integrity check.
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
