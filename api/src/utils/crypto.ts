// api/src/utils/crypto.ts
// AES-256-GCM helpers for encrypting Discord OAuth2 tokens at rest.
// TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes).
//
// The implementation moved to shared/lib/tokenCrypto.ts when the bot began
// needing it too — a customer's dedicated bot token is encrypted here and
// decrypted there, so the two must agree byte for byte. These wrappers keep
// every existing call site unchanged.

import { encryptWithKey, decryptWithKey } from "../../../shared/lib/tokenCrypto.ts";
import { env } from "../env.ts";

export function encrypt(plaintext: string): string {
  return encryptWithKey(plaintext, env.TOKEN_ENCRYPTION_KEY);
}

export function decrypt(payload: string): string {
  return decryptWithKey(payload, env.TOKEN_ENCRYPTION_KEY);
}
