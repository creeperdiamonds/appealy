// shared/lib/tokenCrypto.ts
//
// AES-256-GCM at rest, shared by the API and the bot.
//
// It lives here rather than in api/src/utils because two runtimes now need to
// agree on it byte for byte. The API encrypts a customer's dedicated bot token
// when they save it; the bot decrypts it to connect. Two implementations of
// "the same" format is a bug waiting for the day one of them changes — and the
// failure would be a customer's bot silently refusing to start, with the token
// looking perfectly correct in the dashboard.
//
// node:crypto rather than Web Crypto: Deno implements the node: namespace, so
// one implementation covers both runtimes, and Web Crypto's async API would
// make every call site await something that does not need to be async.
//
// The key is passed in, not read from the environment, because the two
// runtimes read environment variables through different modules. Callers hold
// that difference; this file just does the arithmetic.

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function keyBytes(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars)");
  }
  return key;
}

/** Format: iv:authTag:ciphertext, each base64. Unchanged from the original. */
export function encryptWithKey(plaintext: string, hexKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBytes(hexKey), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

/**
 * Throws on a wrong key or tampered payload — GCM authenticates, so a bad key
 * fails loudly here rather than returning plausible rubbish. Callers are
 * expected to treat that as "ask for the value again", not as a retryable
 * error: nothing about trying twice makes the key correct.
 */
export function decryptWithKey(payload: string, hexKey: string): string {
  const [ivB64, authTagB64, dataB64] = payload.split(":");
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error("Ciphertext is not in the expected iv:authTag:data form");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBytes(hexKey), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
