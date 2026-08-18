// bot/src/core/env.ts
// Centralized, validated environment configuration for the bot process.

import { resolveDeployment, selfHostedCaps, privilegedGuilds } from "../../../shared/config/deployment.ts";
import type { RateLimitTier } from "../../../shared/schema/pricing.ts";

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

/**
 * DISCORD_SKU_TIERS maps Discord SKU ids to internal tiers.
 *
 *   DISCORD_SKU_TIERS=1234567890:tier1,2345678901:tier2
 *
 * Strict on purpose. An unparseable entry means a customer pays and receives
 * nothing, and that failure is completely silent otherwise — no error, no
 * event, just a subscription that does nothing.
 */
function skuTierMap(): Record<string, RateLimitTier> {
  const raw = Deno.env.get("DISCORD_SKU_TIERS")?.trim();
  if (!raw) return {};
  const out: Record<string, RateLimitTier> = {};
  // The real union from shared/schema/pricing.ts. This list also accepted
  // "tier3", which is not a tier anywhere in the system: a SKU mapped to it
  // passed validation and then matched no preset.
  const valid: RateLimitTier[] = ["free", "tier1", "tier2", "custom"];
  for (const pair of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [sku, tier] = pair.split(":").map((x) => x?.trim());
    if (!/^\d{15,25}$/.test(sku ?? "")) {
      throw new Error(`DISCORD_SKU_TIERS: ${JSON.stringify(sku)} is not a SKU id (15-25 digits)`);
    }
    if (!valid.includes((tier ?? "") as RateLimitTier)) {
      throw new Error(`DISCORD_SKU_TIERS: ${JSON.stringify(tier)} is not a tier (${valid.join(", ")})`);
    }
    out[sku] = tier as RateLimitTier;
  }
  return out;
}

function intOption(name: string, fallback: number, min: number, max: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function optional(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

export const deployment = resolveDeployment(
  (k) => Deno.env.get(k),
  (m) => console.info(m),
);

/** Guilds granted raised caps by the operator. See deployment.ts. */
export const PRIVILEGED = privilegedGuilds((k) => Deno.env.get(k), (m) => console.info(m));

export const env = {
  DEPLOYMENT_MODE: deployment.mode,
  SELF_HOSTED_CAPS: selfHostedCaps((k) => Deno.env.get(k)),
  DASHBOARD_URL: optional("DASHBOARD_BASE_URL", "http://localhost:5173"),

  // One shard per this many guilds. 1000 is Discord's own ratio and what its
  // recommendation is derived from; there is rarely a good reason to lower it.
  // Lowering it does NOT spread load more finely for free — it multiplies
  // connections, memory and session starts. See core/sharding.ts.
  /** Discord SKU id -> tier. Empty means Discord subscriptions are off. */
  DISCORD_SKU_TIERS: skuTierMap(),

  // Registers slash commands during boot instead of as a separate task.
  // main.ts reads this and it was never defined here, so the bot did not
  // compile. Off by default: with more than one replica every one of them
  // would race to register the same command set on every restart.
  SYNC_COMMANDS_ON_BOOT: (Deno.env.get("SYNC_COMMANDS_ON_BOOT") ?? "").toLowerCase() === "true",

  GUILDS_PER_SHARD: intOption("GUILDS_PER_SHARD", 1000, 100, 2500),

  // Hard ceiling, so a misconfigured ratio can't try to open hundreds of
  // WebSockets on a small machine. Hitting it logs loudly rather than
  // silently running under-sharded.
  MAX_SHARDS: intOption("MAX_SHARDS", 16, 1, 4096),
  DISCORD_BOT_TOKEN: required("DISCORD_BOT_TOKEN"),
  DISCORD_APPLICATION_ID: required("DISCORD_APPLICATION_ID"),
  DISCORD_PUBLIC_KEY: required("DISCORD_PUBLIC_KEY"),
  DATABASE_URL: required("DATABASE_URL"),
  // Empty or "memory" runs without a Redis container — see
  // shared/lib/memoryRedis.ts. Kept as the localhost default so an existing
  // compose setup is unaffected.
  REDIS_URL: optional("REDIS_URL", "redis://localhost:6379"),
  LOG_LEVEL: optional("LOG_LEVEL", "info"),
  NODE_ENV: optional("APPEALY_ENV", "development"),
} as const;
