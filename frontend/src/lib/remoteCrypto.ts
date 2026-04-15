/**
 * remoteCrypto.ts
 * Browser-side ECDH key exchange and AES-256-GCM encryption for Remote mode.
 *
 * Mirrors the LAN-mode crypto (backend/src/crypto/aesGcm.ts) using the
 * Web Crypto API (SubtleCrypto).  No external dependencies — all primitives
 * are provided by the browser's built-in crypto engine.
 *
 * Key exchange flow (both peers follow these steps simultaneously):
 *  1. generateECDHKeyPair()      — generate ephemeral P-256 key pair
 *  2. exportPublicKeyBase64()    — serialize public key for JSON transport
 *  3. Send 'ecdh_hello' message  — relay public key through DataChannel
 *  4. importPublicKeyBase64()    — deserialize the peer's public key
 *  5. deriveSharedKey()          — ECDH → raw bits → HKDF → AES-256-GCM key
 *  6. All subsequent file chunks are encrypted/decrypted with this shared key
 *
 * Wire format for encrypted chunks:
 *  [ 12 bytes: random AES-GCM IV ] [ N bytes: ciphertext + 16-byte GCM auth tag ]
 *
 * Crypto parameters:
 *  - Curve:     P-256 (prime256v1) — matches LAN mode backend
 *  - KDF:       HKDF-SHA-256 with fixed salt and NexDrop-specific context string
 *  - Symmetric: AES-256-GCM, 12-byte random IV, 128-bit auth tag
 *
 * Why use Web Crypto API instead of a JS library?
 *  - Keys are non-extractable by default — private key bytes never appear in JS heap
 *  - Cryptographic operations run in native browser code — faster and safer than JS
 *  - No supply-chain risk from third-party crypto dependencies
 */

export interface ECDHKeyPair {
  publicKey: CryptoKey;   // extractable — exported to send to peer
  privateKey: CryptoKey;  // non-extractable — stays in the browser's key store
}

/** ECDH curve — must match the backend (ECDH_CURVE = 'prime256v1') */
const CURVE = "P-256";

/**
 * HKDF context string (info parameter).
 * Binds the derived key to this specific protocol version.
 * If the same ECDH output were used in two different protocols, the different
 * info strings guarantee they produce different AES keys — preventing cross-protocol
 * key confusion attacks.
 */
const HKDF_INFO = new TextEncoder().encode("NexDrop-Remote-v1");

/**
 * HKDF salt — all zeros, 32 bytes.
 * An all-zero salt is conventional (RFC 5869 §3.1) when the input keying
 * material (the ECDH shared secret) is already uniformly random, which it is
 * for a properly generated P-256 key pair.
 */
const HKDF_SALT = new Uint8Array(32);

// ── Key generation ────────────────────────────────────────────────────────────

/**
 * Generate a fresh ephemeral ECDH key pair for one transfer session.
 *
 * extractable: true is required for the public key so we can export it and
 * send it to the peer.  The private key is non-extractable by the SubtleCrypto
 * API default, meaning its raw bytes never leave the browser's key storage.
 *
 * deriveKey/deriveBits usages are both needed: deriveBits gives us the raw
 * shared secret for the HKDF step, while deriveKey is required by some
 * SubtleCrypto implementations before they allow deriveBits.
 */
export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: CURVE },
    true, // extractable so we can export the public key
    ["deriveKey", "deriveBits"],
  );
  return pair as ECDHKeyPair;
}

// ── Key serialisation ─────────────────────────────────────────────────────────

/**
 * Export a public key to base64 for JSON transport over the DataChannel.
 *
 * "raw" format exports the uncompressed point (0x04 prefix + 32-byte X + 32-byte Y)
 * — 65 bytes total for P-256.  Base64-encoding this gives an 88-character string
 * that fits easily in a JSON message.
 *
 * The btoa/String.fromCharCode approach is used instead of Buffer (Node-only)
 * or TextDecoder (only works for valid UTF-8) because arbitrary binary bytes
 * need byte-by-byte encoding that btoa handles correctly.
 */
export async function exportPublicKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

/**
 * Import a peer's public key from a base64-encoded raw point.
 *
 * The imported key has no key usages ([]) because public keys are only used
 * as the `public` parameter to deriveBits — not for signing or encryption.
 * SubtleCrypto requires the usage array to match exactly what the key will
 * be used for; an empty array is correct here.
 */
export async function importPublicKeyBase64(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDH", namedCurve: CURVE },
    true,    // extractable (doesn't matter for public keys, but required by some browsers)
    [],      // no key usages — public keys are parameters, not actors
  );
}

// ── Shared key derivation ─────────────────────────────────────────────────────

/**
 * Derive a shared AES-256-GCM encryption key from our private key and the
 * peer's public key.
 *
 * Three-step process:
 *  Step 1: ECDH → raw 256 bits (the Diffie-Hellman shared secret)
 *          Both sides compute the same secret from their own private key +
 *          the other side's public key, without ever transmitting the secret.
 *
 *  Step 2: Wrap the raw bits as an HKDF source key.
 *          Raw bits can't be used directly as a source key in SubtleCrypto;
 *          we must import them as an "HKDF" key first.
 *
 *  Step 3: HKDF → AES-256-GCM key.
 *          HKDF stretches and labels the shared secret into a properly
 *          distributed 256-bit AES key.  The HKDF_INFO binds it to this protocol.
 *
 * The resulting key is non-extractable (false) so it can never be read back
 * out of the browser's key store by JavaScript.
 */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  remotePubKey: CryptoKey,
): Promise<CryptoKey> {
  // Step 1: ECDH → 256 raw bits
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: remotePubKey },
    privateKey,
    256,
  );

  // Step 2: import raw bits as HKDF source key
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,          // non-extractable
    ["deriveKey"],
  );

  // Step 3: HKDF → AES-256-GCM session key
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: HKDF_INFO,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,                   // non-extractable — raw key bytes never leave the browser
    ["encrypt", "decrypt"],
  );
}

// ── Encryption / decryption ───────────────────────────────────────────────────

/**
 * Encrypt a plaintext chunk with AES-256-GCM.
 *
 * A fresh 12-byte random IV is generated for every chunk.  Reusing an IV
 * under the same key would be catastrophic for GCM (leaks keystream and
 * breaks authentication).  With crypto.getRandomValues() the probability of
 * a collision across all chunks of all transfers in a session is negligible
 * (birthday bound: 2^48 chunks needed for 50% collision probability).
 *
 * Output layout: [ 12-byte IV ] [ ciphertext + 16-byte GCM auth tag ]
 * The IV is prepended so the receiver can split it off at fixed byte offset 0.
 *
 * SubtleCrypto.encrypt() appends the auth tag to the ciphertext output —
 * it is NOT a separate field as in the Node.js API.  The receiver must pass
 * the entire (ciphertext + tag) slice to SubtleCrypto.decrypt().
 */
export async function encryptChunk(
  key: CryptoKey,
  plaintext: ArrayBuffer,
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );

  // Prepend IV: [ 12-byte IV ] [ ciphertext+tag ]
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result.buffer;
}

/**
 * Decrypt an encrypted chunk produced by encryptChunk().
 *
 * Splits the first 12 bytes off as the IV, passes the remainder
 * (ciphertext + auth tag) to SubtleCrypto.decrypt().
 *
 * Throws DOMException("OperationError") if the GCM auth tag doesn't verify —
 * meaning the data was tampered with in transit.  Callers must catch this and
 * abort the transfer (ERR-04 in useRemoteTransfer.ts).
 *
 * Edge case — chunk too short:
 * A valid encrypted chunk must be at least 13 bytes (12 IV + 1 ciphertext byte).
 * We throw explicitly rather than letting SubtleCrypto produce a confusing error
 * when given a zero-length ciphertext slice.
 */
export async function decryptChunk(
  key: CryptoKey,
  encrypted: ArrayBuffer,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(encrypted);
  if (bytes.byteLength <= 12) {
    throw new Error("Encrypted chunk too short to contain IV");
  }
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12); // includes the 16-byte GCM auth tag
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

// ── Full-file integrity ───────────────────────────────────────────────────────

/**
 * Compute SHA-256 of arbitrary ArrayBuffer data and return it as a lowercase
 * hex string.
 *
 * Used at the end of a receive sequence to verify the assembled file matches
 * the hash sent by the sender in the 'send_file_end' message.  This is an
 * end-to-end integrity check: even if every individual chunk decrypted
 * successfully, a reassembly bug could produce a wrong file — the hash catches it.
 *
 * The Array.from().map().join() pattern converts each byte to a zero-padded
 * two-character hex string and concatenates them — standard and allocation-cheap
 * for the 32-byte SHA-256 output.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
