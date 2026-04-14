/**
 * remoteCrypto.ts
 * Browser-side ECDH key exchange and AES-256-GCM encryption for Remote mode.
 *
 * Mirrors the LAN-mode crypto (backend/src/crypto/aesGcm.ts) using the
 * Web Crypto API (SubtleCrypto). No external dependencies.
 *
 * Key exchange flow:
 *   1. Both sides call generateECDHKeyPair() on DataChannel open.
 *   2. Both export their public key and send it as an 'ecdh_hello' message.
 *   3. Both call importPublicKey() + deriveSharedKey() when they receive
 *      the remote public key.
 *   4. All subsequent file chunks are encrypted/decrypted with the shared key.
 *
 * Wire format for encrypted chunks:
 *   [ 12 bytes: random IV ] [ ciphertext + 16-byte GCM auth tag ]
 *
 * Crypto parameters:
 *   - ECDH curve: P-256 (prime256v1) — matches LAN mode
 *   - KDF: HKDF-SHA-256 with fixed salt and context string
 *   - Symmetric: AES-256-GCM, 12-byte IV, 128-bit auth tag
 */

export interface ECDHKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

const CURVE = "P-256";
// Context string binds the derived key to this protocol version
const HKDF_INFO = new TextEncoder().encode("NexDrop-Remote-v1");
// All-zero salt is conventional when the IKM is already high-entropy (ECDH output)
const HKDF_SALT = new Uint8Array(32);

// ── Key generation ────────────────────────────────────────────────────────────

/** Generate an ephemeral ECDH key pair for a single transfer session. */
export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: CURVE },
    true, // extractable — we need to export the public key
    ["deriveKey", "deriveBits"],
  );
  return pair as ECDHKeyPair;
}

// ── Key serialisation ─────────────────────────────────────────────────────────

/**
 * Export a public key as raw uncompressed bytes (65 bytes for P-256).
 * Encode as base64 for JSON transport over the DataChannel.
 */
export async function exportPublicKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

/**
 * Import a remote peer's public key from a base64-encoded raw point.
 */
export async function importPublicKeyBase64(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDH", namedCurve: CURVE },
    true,
    [], // public keys have no key usages
  );
}

// ── Shared key derivation ─────────────────────────────────────────────────────

/**
 * Derive a shared AES-256-GCM key from our private key and the peer's public key.
 * ECDH → raw shared secret → HKDF-SHA-256 → AES-256-GCM key.
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

  // Step 2: wrap bits as HKDF source key
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
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
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

// ── Encryption / decryption ───────────────────────────────────────────────────

/**
 * Encrypt a plaintext chunk with AES-256-GCM.
 *
 * Returns: [ 12-byte random IV ][ ciphertext + 16-byte auth tag ]
 * Throws if encryption fails.
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

  // Prepend the IV so the receiver can split it off
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result.buffer;
}

/**
 * Decrypt an encrypted chunk.
 *
 * Expects the same layout produced by encryptChunk:
 *   [ 12-byte IV ][ ciphertext + 16-byte auth tag ]
 *
 * Throws DOMException if the auth tag fails (tampered data).
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
  const ciphertext = bytes.slice(12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

// ── Integrity ─────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 of arbitrary data and return as lowercase hex string.
 * Used for full-file integrity checks (matches LAN mode behaviour).
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
