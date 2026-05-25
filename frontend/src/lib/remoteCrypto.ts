export interface ECDHKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

// must match the backend (ECDH_CURVE = 'prime256v1')
const CURVE = "P-256";

// Binds the derived key to this protocol version so the same ECDH output
// in a different protocol produces a different AES key.
const HKDF_INFO = new TextEncoder().encode("NexDrop-Remote-v1");

// All-zero salt is conventional (RFC 5869 §3.1) when the input keying material
// (ECDH shared secret from a P-256 key pair) is already uniformly random.
const HKDF_SALT = new Uint8Array(32);

export async function generateECDHKeyPair(): Promise<ECDHKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: CURVE },
    true,
    ["deriveKey", "deriveBits"],
  );
  return pair as ECDHKeyPair;
}

export async function exportPublicKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  // btoa over String.fromCharCode handles arbitrary binary bytes; TextDecoder
  // would mangle non-UTF-8 sequences and Buffer is Node-only.
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

export async function importPublicKeyBase64(b64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDH", namedCurve: CURVE },
    true,
    // public keys are parameters to deriveBits, not actors — empty usage array
    [],
  );
}

export async function deriveSharedKey(
  privateKey: CryptoKey,
  remotePubKey: CryptoKey,
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: remotePubKey },
    privateKey,
    256,
  );

  // SubtleCrypto requires raw bits be imported as an HKDF source key before deriveKey.
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: HKDF_INFO,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptChunk(
  key: CryptoKey,
  plaintext: ArrayBuffer,
): Promise<ArrayBuffer> {
  // Fresh 12-byte random IV per chunk — IV reuse under the same GCM key would
  // leak keystream and break authentication.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );

  // Layout: [ 12-byte IV ][ ciphertext + 16-byte GCM auth tag appended by SubtleCrypto ]
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result.buffer;
}

export async function decryptChunk(
  key: CryptoKey,
  encrypted: ArrayBuffer,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(encrypted);
  if (bytes.byteLength <= 12) {
    throw new Error("Encrypted chunk too short to contain IV");
  }
  const iv = bytes.slice(0, 12);
  // ciphertext slice includes the appended 16-byte GCM auth tag
  const ciphertext = bytes.slice(12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
