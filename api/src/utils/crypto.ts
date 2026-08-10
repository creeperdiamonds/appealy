// api/src/utils/crypto.ts
// AES-256-GCM helpers for encrypting Discord OAuth2 tokens at rest.
// TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes).

import crypto from "node:crypto";
import { env } from "../env.ts";

const ALGORITHM = "aes-256-gcm";
const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");

if (key.length !== 32) {
  throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars)");
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // format: iv:authTag:ciphertext, all base64
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(
    ":",
  );
}

export function decrypt(payload: string): string {
  const [ivB64, authTagB64, dataB64] = payload.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}
