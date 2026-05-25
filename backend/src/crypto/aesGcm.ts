import crypto from "crypto";
import { ECDH_CURVE } from "../config";

const KEY_BYTES = 32;

// 12 bytes is the NIST-recommended IV length for AES-GCM — it feeds directly
// into the GCM counter without hashing.
const IV_BYTES = 12;

const AUTH_TAG_BITS = 128;

export interface EncryptResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

// Callers must never reuse an IV with the same key — IV reuse under AES-GCM
// is catastrophic (leaks plaintext and auth key).
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

// Throws "Unsupported state or unable to authenticate data" if the auth tag
// doesn't verify; callers must treat that as an integrity failure and not
// expose the partial plaintext.
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

// HKDF (not raw ECDH output) because the ECDH shared secret is a P-256 point
// with non-uniform distribution and isn't safe to use directly as an AES key.
// The `info` label binds the derived key to this specific protocol.
export function deriveKey(sharedSecret: Buffer, info = "peerdrop-v1"): Buffer {
  // HKDF-Extract: PRK = HMAC-SHA256(salt=0^32, IKM=sharedSecret)
  const prk = crypto
    .createHmac("sha256", Buffer.alloc(32, 0))
    .update(sharedSecret)
    .digest();

  // HKDF-Expand: OKM = HMAC-SHA256(PRK, info || 0x01) — single iteration sufficient for 32 bytes
  const okm = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();

  return okm.subarray(0, KEY_BYTES);
}

export interface ECDHPair {
  publicKeyHex: string;
  privateKey: Buffer;
  ecdh: crypto.ECDH;
}

// Fresh ephemeral pair per transfer gives forward secrecy: recorded
// traffic cannot be decrypted later even if a future bug leaks a key.
export function generateECDHPair(): ECDHPair {
  const ecdh = crypto.createECDH(ECDH_CURVE);
  ecdh.generateKeys();
  return {
    publicKeyHex: ecdh.getPublicKey("hex"),
    privateKey: ecdh.getPrivateKey(),
    ecdh,
  };
}

export function computeSessionKey(
  ecdh: crypto.ECDH,
  peerPublicKeyHex: string,
): Buffer {
  const sharedSecret = ecdh.computeSecret(Buffer.from(peerPublicKeyHex, "hex"));
  return deriveKey(sharedSecret);
}
