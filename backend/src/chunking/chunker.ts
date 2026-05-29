// ─────────────────────────────────────────────────────────────────────────
// LAN FEATURE — DISABLED (line-commented in place; preserved for re-enable).
// To restore: strip the leading "// " from every line below this header,
// then revert the related edits in App.tsx, Home.tsx, config.ts, types.ts.
// See README.md for the active Remote-only build.
// ─────────────────────────────────────────────────────────────────────────

// import crypto from "crypto";
// import { CHUNK_SIZE } from "../config";
// import { encrypt } from "../crypto/aesGcm";
// import type { Chunk } from "../types";
// 
// // NOTE: loads the entire file into memory — appropriate for the current 2 GB
// // limit; for larger files this should stream from disk instead.
// export function chunkFile(
//   transferId: string,
//   fileBuffer: Buffer,
//   sessionKey: Buffer,
//   chunkSize = CHUNK_SIZE,
// ): Chunk[] {
//   const total = Math.ceil(fileBuffer.length / chunkSize);
//   const chunks: Chunk[] = [];
// 
//   for (let i = 0; i < total; i++) {
//     const start = i * chunkSize;
//     const end = Math.min(start + chunkSize, fileBuffer.length);
//     // subarray() returns a view — no data copy, important for memory efficiency
//     const plaintext = fileBuffer.subarray(start, end);
// 
//     // Hash plaintext (not ciphertext) before encrypting — gives a second
//     // independent integrity check beyond AES-GCM's auth tag.
//     const hash = crypto.createHash("sha256").update(plaintext).digest("hex");
// 
//     const { ciphertext, iv, authTag } = encrypt(sessionKey, plaintext);
// 
//     chunks.push({
//       transferId,
//       index: i,
//       total,
//       data: ciphertext,
//       hash,
//       iv,
//       authTag,
//     });
//   }
// 
//   return chunks;
// }
// 
// export function hashFile(fileBuffer: Buffer): string {
//   return crypto.createHash("sha256").update(fileBuffer).digest("hex");
// }

export {};
