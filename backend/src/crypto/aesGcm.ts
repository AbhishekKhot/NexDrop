/**
 * aesGcm.ts
 * AES-256-GCM authenticated encryption/decryption.
 *
 * Properties:
 *  - Confidentiality: AES-256 CBC-mode stream is not observable
 *  - Authenticity:    GCM auth tag (16 bytes) detects any modification to ciphertext
 *  - Uniqueness:      12-byte random IV per chunk — ensures no IV reuse across chunks
 *
 * Usage:
 *   const key = deriveKey(sharedSecret);        // 32-byte buffer
 *   const { ciphertext, iv, authTag } = encrypt(key, plaintext);
 *   const plaintext = decrypt(key, ciphertext, iv, authTag);
 */

import crypto from "crypto";
import { ECDH_CURVE } from "../config";

/** AES-256-GCM key size in bytes */
const KEY_BYTES = 32;

/** GCM nonce / IV size in bytes */
const IV_BYTES = 12;

/** GCM auth tag size in bits */
const AUTH_TAG_BITS = 128;

export interface EncryptResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Encrypt a plaintext buffer.
 * @param key 32-byte AES key (derived from ECDH shared secret via deriveKey())
 * @param plaintext Raw bytes to encrypt
 */
export function encrypt(key: Buffer, plaintext: Buffer): EncryptResult {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * Decrypt a ciphertext buffer.
 * Throws if auth tag verification fails (tampered data).
 * @param key 32-byte AES key
 * @param ciphertext Encrypted bytes
 * @param iv Nonce used during encryption
 * @param authTag GCM auth tag
 */
export function decrypt(
  key: Buffer,
  ciphertext: Buffer,
  iv: Buffer,
  authTag: Buffer,
): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Derive a 32-byte AES key from an ECDH shared secret using HKDF-SHA256.
 * @param sharedSecret Raw bytes from ECDH computeSecret()
 * @param info Optional context label (e.g. 'peerdrop-v1')
 */
export function deriveKey(sharedSecret: Buffer, info = "peerdrop-v1"): Buffer {
  // HKDF extract + expand (RFC 5869)
  const prk = crypto
    .createHmac("sha256", Buffer.alloc(32, 0))
    .update(sharedSecret)
    .digest();
  const okm = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
  return okm.subarray(0, KEY_BYTES);
}

// ─── ECDH key pair ────────────────────────────────────────────────────────────

export interface ECDHPair {
  publicKeyHex: string;
  privateKey: Buffer;
  ecdh: crypto.ECDH;
}

/**
 * Generate an ephemeral ECDH P-256 key pair.
 * Call this once per transfer session for forward secrecy.
 */
export function generateECDHPair(): ECDHPair {
  const ecdh = crypto.createECDH(ECDH_CURVE);
  ecdh.generateKeys();
  return {
    publicKeyHex: ecdh.getPublicKey("hex"),
    privateKey: ecdh.getPrivateKey(),
    ecdh,
  };
}

/**
 * Compute the shared secret from our ECDH instance and the peer's public key.
 * Then derive a 32-byte AES key from it.
 */
export function computeSessionKey(
  ecdh: crypto.ECDH,
  peerPublicKeyHex: string,
): Buffer {
  const sharedSecret = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, "hex"));
  return deriveKey(sharedSecret);
}
