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

const FREE_CAPS = RATE_LIMIT_PRESETS.free.caps;

export function resolveEffectiveCaps(guild: typeof schema.guilds.$inferSelect): RateLimitCaps {
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
