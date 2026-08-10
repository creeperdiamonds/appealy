// api/src/services/rateLimitService.ts
//
// API-side counterpart to bot/src/services/rateLimitService.ts. The API
// only needs to check "standing" caps (forms/panels per guild) — the
// per-day event caps (submissions, tickets, giveaway entries) are enforced
// by the bot at the point of the Discord interaction, since that's where
// the volume actually happens; duplicating that Redis-window logic here
// would just create two sources of truth for the same counter.
//
// Both this file and the bot's version call the same pure resolver logic
// from shared/schema/pricing.ts, so a guild's effective caps can never
// differ depending on which process is asking.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import {
  RATE_LIMIT_PRESETS,
  CUSTOM_CAP_MAXIMUMS,
  type RateLimitCaps,
} from "../../../shared/schema/pricing.ts";
import { deployment, env, PRIVILEGED } from "../env.ts";

const FREE_CAPS = RATE_LIMIT_PRESETS.free.caps;

/**
 * Self-hosted caps, built once from env.
 *
 * A tier is a billing concept and a self-hoster has no billing, so every
 * guild on a self-hosted instance gets the same flat numbers. The caps still
 * exist — they protect the operator's own Postgres pool, which is the real
 * constraint — but they are no longer a product ladder, and the person who
 * sets them owns the database they protect.
 *
 * Anything in RateLimitCaps that has no CAP_* env equivalent falls back to
 * the tier2 preset rather than to free: a self-hoster should never be more
 * restricted than a paying customer on their own hardware.
 */
const SELF_HOSTED_CAPS: RateLimitCaps = {
  ...RATE_LIMIT_PRESETS.tier2.caps,
  ...env.SELF_HOSTED_CAPS,
};

/**
 * Caps for privileged guilds. CUSTOM_CAP_MAXIMUMS unless a PRIVILEGED_CAP_*
 * says otherwise — "as high as this system was designed to go" is a safer
 * starting point than an invented number, and the overrides are there for
 * when it genuinely isn't enough.
 *
 * Still finite. Your own server shares the same Postgres pool as every other
 * guild, so an uncapped runaway loop in it takes everyone down with it.
 */
const PRIVILEGED_CAPS: RateLimitCaps = {
  ...CUSTOM_CAP_MAXIMUMS,
  ...PRIVILEGED.overrides,
};


export function resolveEffectiveCaps(guild: typeof schema.guilds.$inferSelect): RateLimitCaps {
  // Privileged guilds win over everything — tier, custom caps, self mode.
  // This is the operator's own server, granted by env, and it is deliberately
  // NOT clamped to CUSTOM_CAP_MAXIMUMS: that ceiling exists to stop a customer
  // self-serving unbounded throughput, and there is no purchase to bound here.
  if (PRIVILEGED.ids.has(guild.id.toString())) {
    return PRIVILEGED_CAPS;
  }

  // Checked before the tier is read at all. In self mode `guild.rateLimitTier`
  // is meaningless — it defaults to "free" on every row, and honouring it
  // would cap a self-hoster with someone else's price list.
  if (!deployment.features.tieredRateLimits) {
    return SELF_HOSTED_CAPS;
  }

  if (guild.rateLimitTier !== "custom") {
    return RATE_LIMIT_PRESETS[guild.rateLimitTier].caps;
  }
  const stored = guild.customRateLimits ?? {};
  const resolved = {} as RateLimitCaps;
  for (const key of Object.keys(FREE_CAPS) as (keyof RateLimitCaps)[]) {
    const requested = stored[key] ?? FREE_CAPS[key];
    resolved[key] = Math.min(requested, CUSTOM_CAP_MAXIMUMS[key]);
  }
  return resolved;
}

export interface StandingCapCheck {
  allowed: boolean;
  current: number;
  limit: number;
}

export async function checkStandingCap(
  guildId: bigint,
  capName: "formsPerGuild" | "panelsPerGuild",
  currentCount: number,
): Promise<StandingCapCheck> {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  const caps = guild ? resolveEffectiveCaps(guild) : FREE_CAPS;
  const limit = caps[capName];
  return { allowed: currentCount < limit, current: currentCount, limit };
}
