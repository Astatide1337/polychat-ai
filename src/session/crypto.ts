import { createDecipheriv, createCipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config/index.js";

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

// Key cache: avoids re-deriving the same key on every request.
const keyCache = new Map<string, Buffer>();

export function deriveKey(secret: string, salt: string): Buffer {
  const cacheKey = `${secret}:${salt}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const key = scryptSync(`${secret}:${salt}`, "polychat-session-key", 32) as Buffer;
  keyCache.set(cacheKey, key);
  return key;
}

/**
 * Return the active encryption key.
 *
 * Key material priority:
 *   1. POLYCHAT_SECRET_KEY env var (portable — works on any machine)
 *   2. Error: no silent fallback.
 *
 * POLYCHAT_SECRET_KEY must be at least 32 hex characters (128 bits).
 * Generate one with: openssl rand -hex 32
 */
export function getEncryptionKey(): Buffer {
  const envKey = process.env.POLYCHAT_SECRET_KEY?.trim();
  if (!envKey) {
    throw new Error(
      "POLYCHAT_SECRET_KEY is not set.\n" +
      "Generate one with:  openssl rand -hex 32\n" +
      "Then set it in your environment before starting polychat.",
    );
  }
  if (envKey.length < 32) {
    throw new Error(
      `POLYCHAT_SECRET_KEY is too short (${envKey.length} chars). Must be at least 32 characters.\n` +
      "Generate a valid key with:  openssl rand -hex 32",
    );
  }
  const { sessionSalt } = loadConfig();
  return deriveKey(envKey, sessionSalt);
}

/**
 * Derive a transport key used to protect session blobs in transit.
 * Combines the server's API key and a per-request nonce so that a
 * captured blob cannot be replayed against a different server or
 * decrypted without the API key.
 *
 * @param apiKey   - the server's POLYCHAT_API_KEY
 * @param nonce    - random hex nonce included in the wire payload
 * @param salt     - server's sessionSalt (stops cross-server replay)
 */
export function deriveTransportKey(apiKey: string, nonce: string, salt: string): Buffer {
  return deriveKey(`transport:${apiKey}:${nonce}`, salt);
}

// ---------------------------------------------------------------------------
// Primitive AES-256-GCM helpers
// Wire format: [16-byte IV][16-byte auth tag][ciphertext]
// ---------------------------------------------------------------------------

export function encrypt(data: string, key: Buffer): Buffer {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decrypt(encrypted: Buffer, key: Buffer): string {
  if (encrypted.length < 33) throw new Error("Encrypted data is too short");
  const iv = encrypted.subarray(0, 16);
  const tag = encrypted.subarray(16, 32);
  const ciphertext = encrypted.subarray(32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// ---------------------------------------------------------------------------
// Transport envelope
//
// Used when pushing session blobs over the network. Wraps the session
// payload in a second layer of encryption keyed to the API key + a nonce,
// so the blob is useless to a network observer even if TLS is compromised.
//
// Wire JSON shape (base64url-encoded ciphertext):
// {
//   "v": 1,
//   "provider": "claude",
//   "nonce": "<16-byte hex>",
//   "created_at": "<ISO timestamp>",
//   "ciphertext": "<base64 of iv+tag+ciphertext>"
// }
// ---------------------------------------------------------------------------

export interface TransportEnvelope {
  v: 1;
  provider: string;
  nonce: string;
  created_at: string;
  ciphertext: string;  // base64(iv + tag + encrypted_session_json)
}

/**
 * Seal a session StorageState JSON for wire transport.
 * The caller supplies the server's API key; only a server with that key
 * can unseal it.
 */
export function sealForTransport(
  sessionJson: string,
  provider: string,
  apiKey: string,
  salt: string,
): TransportEnvelope {
  const nonce = randomBytes(16).toString("hex");
  const key = deriveTransportKey(apiKey, nonce, salt);
  const ciphertext = encrypt(sessionJson, key);
  return {
    v: 1,
    provider,
    nonce,
    created_at: new Date().toISOString(),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Unseal a transport envelope received from a session push.
 * Verifies the envelope version and returns the raw session JSON.
 * Throws if the envelope is malformed, the key is wrong, or authentication fails.
 */
export function unsealTransportEnvelope(
  envelope: TransportEnvelope,
  apiKey: string,
  salt: string,
): string {
  if (envelope.v !== 1) throw new Error(`Unsupported envelope version: ${envelope.v}`);
  if (!envelope.provider || !envelope.nonce || !envelope.ciphertext) {
    throw new Error("Malformed transport envelope");
  }
  const key = deriveTransportKey(apiKey, envelope.nonce, salt);
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  return decrypt(ciphertext, key);
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

export function encryptionSelfTest() {
  const key = getEncryptionKey();
  const message = "polychat-encryption-self-test";
  const encrypted = encrypt(message, key);
  const decrypted = decrypt(encrypted, key);
  if (decrypted !== message) throw new Error("Encryption self-test failed");
  return true;
}

// ---------------------------------------------------------------------------
// Constant-time comparison (prevents timing attacks on key/token comparison)
// ---------------------------------------------------------------------------

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ab, bb);
}
