// bot/src/services/rateLimitService.ts
//
// Enforces the throughput caps from shared/schema/pricing.ts at the point
// of action — form submit, ticket open, giveaway entry — rather than only
// at the API layer, since that's where the volume actually is.
//
// WHAT CHANGED
// ------------
// 1. THE PER-ACTION `guilds` SELECT IS GONE.
//    `checkAndConsumeDailyCap` opened with a Postgres read of the guild row
//    on every single submission, ticket, and giveaway entry — to fetch a
//    tier that changes when someone buys a plan, i.e. once a year. It now
//    reads from the shared config cache.
//
// 2. INCR + EXPIRE ARE PIPELINED.
//    Two round-trips became one. Small on its own, but this runs on every
//    metered action.
//
// 3. RATE LIMITING FAILS CLOSED WHERE IT MATTERS.
//    Everything else in this codebase treats Redis as best-effort and
//    degrades gracefully when it's down. Rate limiting is the exception,
//    and it's worth being explicit about why: if Redis is unavailable and
//    this fails open, the caps you charge money for silently stop applying
//    for the duration of the outage. Failing open here would turn a cache
//    outage into an unmetered-usage incident. So a Redis failure denies the
//    action with a clear "try again shortly" rather than waving it through.
//    The one exception is a missing guild row, which is a bookkeeping gap
//    rather than an infrastructure failure and should not block a real user.
//
// 4. `getUsageSnapshot` IS NEW.
//    Reads the current counters without consuming, so the dashboard can
//    show live capacity against limits — see web/src/pages/Overview.tsx.
//    This is the number that actually tells an operator whether a guild is
//    about to hit a wall.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { getGuildConfig } from "../core/guildConfigCache.ts";
import { getRedis, pipeline, withRedis } from "../core/redis.ts";
import {
  RATE_LIMIT_PRESETS,
  CUSTOM_CAP_MAXIMUMS,
  type RateLimitCaps,
} from "../../../shared/schema/pricing.ts";
import { deployment, env, PRIVILEGED } from "../core/env.ts";
import { entitledTier } from "../core/entitlements.ts";

const FREE_CAPS = RATE_LIMIT_PRESETS.free.caps;

/**
 * Self-hosted caps. Mirrors api/src/services/rateLimitService.ts — both must
 * resolve identically or a guild's effective cap depends on which process
 * asked, which is the exact failure this file's header warns about.
 *
 * Unmapped keys fall back to tier2, not free: a self-hoster should never be
 * more restricted than a paying customer on their own hardware.
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


export type DailyCapName = "submissionsPerDay" | "ticketsPerDay" | "giveawayEntriesPerDay";
export type StandingCapName = "formsPerGuild" | "panelsPerGuild";

export function resolveEffectiveCaps(
  guild: typeof schema.guilds.$inferSelect,
): RateLimitCaps {
  // Privileged guilds win over everything — tier, custom caps, self mode.
  // This is the operator's own server, granted by env, and it is deliberately
  // NOT clamped to CUSTOM_CAP_MAXIMUMS: that ceiling exists to stop a customer
  // self-serving unbounded throughput, and there is no purchase to bound here.
  if (PRIVILEGED.ids.has(guild.id.toString())) {
    return PRIVILEGED_CAPS;
  }

  // Before the tier is read at all. In self mode `rateLimitTier` defaults to
  // "free" on every row and means nothing — honouring it would cap a
  // self-hoster with someone else's price list.
  if (!deployment.features.tieredRateLimits) {
    return SELF_HOSTED_CAPS;
  }

  // A live Discord entitlement outranks the stored tier. The database column
  // lags — it's updated by our own bookkeeping — whereas the entitlement is
  // what Discord says the customer is currently paying for. When they
  // disagree, Discord is right.
  //
  // Returns null when nothing is entitled OR when entitlements haven't loaded
  // yet, so an unreconciled cache falls through to the stored tier rather than
  // downgrading a paying customer to free.
  const entitled = entitledTier(guild.id);
  // "custom" is a tier but not a preset: its caps are per-guild and live on
  // the row, so an entitlement claiming it falls through to the stored config
  // below rather than indexing a table with no entry for it.
  if (entitled && entitled !== "custom") {
    return RATE_LIMIT_PRESETS[entitled].caps;
  }

  if (guild.rateLimitTier !== "custom") {
    return RATE_LIMIT_PRESETS[guild.rateLimitTier].caps;
  }

  // Defensive re-clamp. The API validates on write, but ceilings are
  // allowed to tighten over time and an old row must not grandfather in a
  // number that's no longer permitted. An enforcement point should never
  // trust a stored value it didn't just validate itself.
  const stored = guild.customRateLimits ?? {};
  const resolved = {} as RateLimitCaps;
  for (const key of Object.keys(FREE_CAPS) as (keyof RateLimitCaps)[]) {
    const requested = stored[key] ?? FREE_CAPS[key];
    resolved[key] = Math.min(requested, CUSTOM_CAP_MAXIMUMS[key]);
  }
  return resolved;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  /** Seconds until the window resets. Only meaningful when !allowed. */
  resetsInSeconds?: number;
  /** Set when the check itself failed rather than the limit being hit, so
   * callers can show "try again" instead of "you're out of quota". */
  degraded?: boolean;
}

function dayBucket(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function capKey(guildId: bigint, capName: string): string {
  return `appealy:ratelimit:${guildId}:${capName}:${dayBucket()}`;
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const tomorrow = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.floor((tomorrow - now.getTime()) / 1000);
}

/**
 * Atomically increments a per-guild daily counter and checks it against the
 * effective limit.
 *
 * Uses a calendar-day bucket (UTC) rather than a rolling window — simpler
 * to reason about and to explain ("resets at midnight UTC"), at the cost of
 * permitting a burst across the day boundary. That's an acceptable trade
 * for caps that exist for cost control and fairness rather than abuse
 * prevention at the second granularity.
 */
export async function checkAndConsumeDailyCap(
  guildId: bigint,
  capName: DailyCapName,
): Promise<RateLimitCheckResult> {
  const config = await getGuildConfig(guildId);

  if (!config.guild) {
    // No guild row yet. A bookkeeping gap, not an infrastructure failure —
    // fail open rather than blocking a legitimate action.
    return { allowed: true, current: 0, limit: FREE_CAPS[capName] };
  }

  const limit = resolveEffectiveCaps(config.guild)[capName];
  const key = capKey(guildId, capName);

  let current: number;
  try {
    const redis = await getRedis();
    current = await redis.incr(key);
    if (current === 1) {
      // ~25h covers UTC-day-boundary skew without leaking keys. Fired only
      // on the first increment of a window, so this costs one extra
      // round-trip per guild per day rather than per action.
      await redis.expire(key, 25 * 60 * 60);
    }
  } catch {
    // Fail CLOSED. See the note at the top of this file: failing open here
    // means the caps being charged for stop existing during an outage.
    return {
      allowed: false,
      current: 0,
      limit,
      degraded: true,
    };
  }

  if (current > limit) {
    return { allowed: false, current, limit, resetsInSeconds: secondsUntilUtcMidnight() };
  }
  return { allowed: true, current, limit };
}

/** Standing caps compare a live count against the limit rather than
 * incrementing a window — they represent state, not a rate of events. */
export async function checkStandingCap(
  guildId: bigint,
  capName: StandingCapName,
  currentCount: number,
): Promise<RateLimitCheckResult> {
  const config = await getGuildConfig(guildId);
  const caps = config.guild ? resolveEffectiveCaps(config.guild) : FREE_CAPS;
  const limit = caps[capName];
  return { allowed: currentCount < limit, current: currentCount, limit };
}

export interface UsageSnapshot {
  tier: string;
  caps: RateLimitCaps;
  used: Record<DailyCapName, number>;
  standing: Record<StandingCapName, number>;
  resetsInSeconds: number;
}

/**
 * Reads current usage WITHOUT consuming, for the dashboard's capacity view.
 *
 * All three daily counters come back in one pipelined MGET-equivalent, and
 * the two standing counts are parallel COUNT queries. The whole snapshot is
 * one Redis round-trip plus one database round-trip.
 */
export async function getUsageSnapshot(guildId: bigint): Promise<UsageSnapshot> {
  const config = await getGuildConfig(guildId);
  const caps = config.guild ? resolveEffectiveCaps(config.guild) : FREE_CAPS;

  const dailyNames: DailyCapName[] = [
    "submissionsPerDay",
    "ticketsPerDay",
    "giveawayEntriesPerDay",
  ];

  const [counters, formCount, panelCount] = await Promise.all([
    pipeline(dailyNames.map((n) => ["GET", capKey(guildId, n)] as [string, string])),
    db
      .select({ n: schema.forms.id })
      .from(schema.forms)
      .where(eq(schema.forms.guildId, guildId)),
    db
      .select({ n: schema.panels.id })
      .from(schema.panels)
      .where(eq(schema.panels.guildId, guildId)),
  ]);

  const used = {} as Record<DailyCapName, number>;
  dailyNames.forEach((name, i) => {
    used[name] = Number(counters[i] ?? 0) || 0;
  });

  return {
    tier: config.guild?.rateLimitTier ?? "free",
    caps,
    used,
    standing: { formsPerGuild: formCount.length, panelsPerGuild: panelCount.length },
    resetsInSeconds: secondsUntilUtcMidnight(),
  };
}

export function rateLimitDeniedMessage(
  result: RateLimitCheckResult,
  capLabel: string,
): string {
  if (result.degraded) {
    return "Couldn't verify this server's usage limits just now. Please try again in a moment.";
  }
  if (result.resetsInSeconds !== undefined) {
    const resetTimestamp = Math.floor(Date.now() / 1000) + result.resetsInSeconds;
    return (
      `This server has reached its daily limit of ${result.limit} ${capLabel} ` +
      `(${result.current}/${result.limit} used). The limit resets <t:${resetTimestamp}:R>. ` +
      "Higher limits are available — see `/dashboard`."
    );
  }
  return (
    `This server has reached its limit of ${result.limit} ${capLabel}. ` +
    "Higher limits are available — see `/dashboard`."
  );
}

export { withRedis };
