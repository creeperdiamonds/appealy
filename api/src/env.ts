// api/src/env.ts

import { resolveDeployment, selfHostedCaps, privilegedGuilds } from "../../shared/config/deployment.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Required in platform mode, absent in self-hosted.
 *
 * The payment credentials were unconditionally required, which meant a fresh
 * clone of an open-source project crashed on startup asking for a merchant
 * account it had no reason to have.
 */
function requiredInPlatformMode(name: string): string {
  if (deployment.mode !== "platform") return "";
  return required(name);
}

/**
 * Allowlist of Discord user IDs permitted to reach the operator surface.
 *
 * A Discord user ID is NOT a secret — it's in every mention. This list is
 * authorization only; identity is established exclusively by the OAuth
 * session, which is why requireOpsUser reads req.userId and never a header,
 * query string, or body. Leaking this list is not a breach. Shipping a code
 * path that trusts a client-supplied id is.
 *
 * Parsing is strict and startup fails on a malformed entry — a typo would
 * otherwise silently lock out one operator and look like it worked.
 */
function opsUserIds(): ReadonlySet<string> {
  const raw = process.env.OPS_USER_IDS?.trim();
  if (!raw) return new Set();
  const ids = raw.split(",").map((x) => x.trim()).filter(Boolean);
  for (const id of ids) {
    if (!/^\d{15,25}$/.test(id)) {
      throw new Error(`OPS_USER_IDS contains something that isn't a Discord user ID: ${JSON.stringify(id)}`);
    }
  }
  return new Set(ids);
}

// Logged via console rather than utils/logger.ts on purpose: env.ts is
// imported by the logger's own config path, and importing it here would be a
// cycle. One line at startup doesn't justify untangling that.
export const deployment = resolveDeployment(
  (k) => process.env[k],
  (m) => console.info(m),
);

/** Guilds granted raised caps by the operator. See deployment.ts. */
export const PRIVILEGED = privilegedGuilds((k) => process.env[k], (m) => console.info(m));

export const env = {
  DEPLOYMENT_MODE: deployment.mode,
  OPS_USER_IDS: opsUserIds(),
  /** Only consulted when deployment.features.tieredRateLimits is false. */
  SELF_HOSTED_CAPS: selfHostedCaps((k) => process.env[k]),
  // Cloud Run injects PORT at runtime; optional() already reads it.
  PORT: Number(optional("PORT", "3001")),
  DATABASE_URL: required("DATABASE_URL"),
  // The API now needs Redis for the OAuth state store, the guild
  // permission cache, and per-guild API rate limiting. Optional with a
  // localhost default to match the bot's env module, so a dev machine
  // running `docker compose up redis` needs no extra configuration.
  // Empty or "memory" runs without a Redis container — see
  // shared/lib/memoryRedis.ts. Kept as the localhost default so an existing
  // compose setup is unaffected.
  REDIS_URL: optional("REDIS_URL", "redis://localhost:6379"),
  DISCORD_CLIENT_ID: required("DISCORD_CLIENT_ID"),
  DISCORD_CLIENT_SECRET: required("DISCORD_CLIENT_SECRET"),
  DISCORD_REDIRECT_URI: required("DISCORD_REDIRECT_URI"),
  DISCORD_BOT_TOKEN: required("DISCORD_BOT_TOKEN"),
  SESSION_SECRET: required("SESSION_SECRET"),
  TOKEN_ENCRYPTION_KEY: required("TOKEN_ENCRYPTION_KEY"), // 32-byte hex key for AES-256-GCM
  // Tebex is the merchant of record — it sells to the customer, collects the
  // money, and owns sales tax and VAT registration and remittance. That is
  // what removes the need for a taxpayer identification number of our own.
  //
  // Both halves of the Basic auth pair are configured rather than derived:
  // Tebex names them differently in different places, and guessing produces a
  // 401 at request time that says nothing about which half was wrong.
  TEBEX_PROJECT_ID: requiredInPlatformMode("TEBEX_PROJECT_ID"),
  TEBEX_PRIVATE_KEY: requiredInPlatformMode("TEBEX_PRIVATE_KEY"),
  TEBEX_WEBHOOK_SECRET: requiredInPlatformMode("TEBEX_WEBHOOK_SECRET"),
  FRONTEND_ORIGIN: optional("FRONTEND_ORIGIN", "http://localhost:5173"),
  NODE_ENV: optional("NODE_ENV", "development"),
} as const;
