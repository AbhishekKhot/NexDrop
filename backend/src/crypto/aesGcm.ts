/**
 * aesGcm.ts
 * AES-256-GCM authenticated encryption and ECDH key exchange for LAN mode.
 *
 * Security properties:
 *  - Confidentiality:  AES-256 with a session key derived from ECDH — only the
 *                      two parties who performed the handshake can decrypt.
 *  - Authenticity:     GCM auth tag (16 bytes) detects any modification to
 *                      ciphertext or IV in transit.  decryptChunk() throws if
 *                      the tag doesn't verify.
 *  - IV uniqueness:    12 bytes of crypto.randomBytes() per chunk.  Reusing an
 *                      IV under the same key would be catastrophic for GCM
 *                      (leaks both plaintext and auth key); random IVs make
 *                      collision probability negligible at 256 KB chunks.
 *  - Forward secrecy:  generateECDHPair() produces a fresh ephemeral key pair
 *                      per transfer.  Even if a long-term key were compromised,
 *                      past session recordings cannot be decrypted.
 *
 * Usage pattern:
 *   // Sender
 *   const myEcdh = generateECDHPair();
 *   // ... exchange myEcdh.publicKeyHex with receiver over the wire ...
 *   const sessionKey = computeSessionKey(myEcdh.ecdh, peerPublicKeyHex);
 *   const { ciphertext, iv, authTag } = encrypt(sessionKey, plaintext);
 *
 *   // Receiver
 *   const myEcdh = generateECDHPair();
 *   const sessionKey = computeSessionKey(myEcdh.ecdh, senderPublicKeyHex);
 *   const plaintext = decrypt(sessionKey, ciphertext, iv, authTag);
 */

import crypto from "crypto";
import { ECDH_CURVE } from "../config";

/** AES-256-GCM requires a 32-byte (256-bit) key */
const KEY_BYTES = 32;

/**
 * GCM nonce size.  12 bytes is the NIST-recommended IV length for AES-GCM —
 * it feeds directly into the GCM counter without hashing, giving the best
 * performance and the tightest security proof.
 */
const IV_BYTES = 12;

/**
 * GCM auth tag length in bits.
 * 128-bit (16-byte) tags are the maximum and recommended size — any shorter
 * tag reduces the forgery resistance guarantee.
 */
const AUTH_TAG_BITS = 128;

export interface EncryptResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Encrypt a plaintext buffer with AES-256-GCM.
 *
 * A fresh random IV is generated for every call — callers must never reuse
 * an IV with the same key.  The IV is returned alongside ciphertext and authTag
 * so the caller can store or transmit all three together.
 *
 * @param key       32-byte AES session key (from computeSessionKey / deriveKey)
 * @param plaintext Raw bytes to encrypt
 * @returns         { ciphertext, iv, authTag } — all three are required for decryption
 */
export function encrypt(key: Buffer, plaintext: Buffer): EncryptResult {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_BITS / 8,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // getAuthTag() must be called AFTER cipher.final() — before that the tag is incomplete
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * Decrypt a ciphertext buffer and verify its GCM auth tag.
 *
 * If the auth tag doesn't match — meaning the ciphertext, IV, or tag was
 * modified in transit — Node throws "Unsupported state or unable to
 * authenticate data".  Callers must catch this and treat it as an integrity
 * failure (do not expose the partial plaintext).
 *
 * @param key        32-byte AES session key
 * @param ciphertext Encrypted bytes (output of cipher.update + cipher.final)
 * @param iv         12-byte nonce used during encryption
 * @param authTag    16-byte GCM tag from the sender
 * @returns          Decrypted plaintext — only valid if no exception was thrown
 */
export function decrypt(
  key: Buffer,
  ciphertext: Buffer,
  iv: Buffer,
  authTag: Buffer,
): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  // setAuthTag must be called before any update() — the decipher verifies it
  // internally during final(), throwing if authentication fails
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Derive a 32-byte AES session key from an ECDH raw shared secret using HKDF-SHA256.
 *
 * Why HKDF instead of using the raw ECDH output directly?
 *  - The ECDH shared secret is a point on the P-256 curve — its distribution
 *    is not uniform, so it isn't safe to use directly as an AES key.
 *  - HKDF "extract + expand" (RFC 5869) produces a uniformly distributed key
 *    regardless of the input's distribution.
 *  - The `info` label binds the derived key to this specific protocol, so
 *    a session key from one protocol can't be confused with one from another.
 *
 * This is a simplified HKDF: production code should use Node 21+'s
 * crypto.hkdfSync() for clarity, but this implementation is correct and tested.
 *
 * @param sharedSecret  Raw bytes from ecdh.computeSecret()
 * @param info          Optional context label (binds key to protocol version)
 */
export function deriveKey(sharedSecret: Buffer, info = "peerdrop-v1"): Buffer {
  // HKDF-Extract: PRK = HMAC-SHA256(salt=0^32, IKM=sharedSecret)
  const prk = crypto
    .createHmac("sha256", Buffer.alloc(32, 0)) // all-zero salt (conventional when IKM is high-entropy)
    .update(sharedSecret)
    .digest();

  // HKDF-Expand: OKM = HMAC-SHA256(PRK, info || 0x01) — single iteration sufficient for 32 bytes
  const okm = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();

  return okm.subarray(0, KEY_BYTES);
}

// ─── ECDH key pair ────────────────────────────────────────────────────────────

/**
 * A handle to an ephemeral ECDH key pair.
 *
 * The `ecdh` field is kept alive so that computeSessionKey() can call
 * ecdh.computeSecret() with the peer's public key after the exchange.
 * publicKeyHex is the value transmitted to the peer.
 */
export interface ECDHPair {
  publicKeyHex: string;   // uncompressed P-256 point, hex-encoded
  privateKey: Buffer;     // raw private key bytes (not transmitted)
  ecdh: crypto.ECDH;      // Node ECDH instance, kept for computeSecret()
}

/**
 * Generate a fresh ephemeral ECDH P-256 key pair.
 *
 * This is called once per transfer session on both sides.  The private key
 * never leaves the process; only the public key is transmitted.  Generating
 * a new pair for every transfer provides forward secrecy: recording encrypted
 * traffic today cannot be decrypted even if a future software bug leaks a key,
 * because each session's key is derived from a one-time ephemeral exchange.
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
 * Compute the shared AES session key from our ECDH instance and the peer's public key.
 *
 * ECDH.computeSecret() performs the Diffie-Hellman operation:
 *   sharedSecret = ourPrivateKey × peerPublicKey (mod the curve)
 * Both sides arrive at the same sharedSecret because ECDH is commutative.
 * deriveKey() then stretches and labels it into a proper AES-256 key.
 *
 * @param ecdh             Our ECDH instance (from generateECDHPair)
 * @param peerPublicKeyHex The peer's hex-encoded public key received from the wire
 */
export function computeSessionKey(
  ecdh: crypto.ECDH,
  peerPublicKeyHex: string,
): Buffer {
  const sharedSecret = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, "hex"));
  return deriveKey(sharedSecret);
}
