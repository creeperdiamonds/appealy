// api/src/middleware/apiRateLimit.ts
//
// Enforces `apiRequestsPerMinute` from shared/schema/pricing.ts.
//
// THIS CAP WAS BEING CHARGED FOR AND NEVER ENFORCED.
// --------------------------------------------------
// `apiRequestsPerMinute` appears in RATE_LIMIT_PRESETS (60 free / 180 tier1
// / 600 tier2), in CUSTOM_CAP_MAXIMUMS (2,000), in the per-unit pricing
// table, and in the zod schema for the custom-caps checkout body. A guild
// admin can move that slider, see the price go up, and pay for it.
//
// Grepping the repository for the identifier turns up only pricing.ts and
// billing.ts. No middleware read it. No route consulted it. The number was
// priced and sold, and then nothing anywhere in the codebase used it to
// limit anything. `historyRetentionDays` and `rolesPerRuleType` had the
// same problem — see SCALING.md; retention is now enforced by the
// scheduler's purge job, and the role cap by validation in the forms route.
//
// Separately from the billing question, an API with no rate limiting at all
// has no defense against a single misbehaving dashboard tab hammering an
// endpoint, and every one of those requests reaches Postgres.
//
// IMPLEMENTATION
// --------------
// A fixed-window counter per (guild, minute). A sliding window would be
// more precise at the boundary, but the boundary burst is bounded at 2x for
// one minute and the cost is one INCR instead of a sorted-set read-modify-
// write on every request. For a capacity limit rather than an abuse
// control, that's the right trade — and it matches the calendar-day bucket
// the bot already uses for its own caps, so the two behave consistently.
//
// Standard `X-RateLimit-*` and `Retry-After` headers are returned so the
// dashboard can back off intelligently rather than retrying blindly into a
// wall.

import type { Request, Response, NextFunction } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { withRedis } from "../lib/redis.ts";
import { resolveEffectiveCaps } from "../services/rateLimitService.ts";
import { RATE_LIMIT_PRESETS } from "../../../shared/schema/pricing.ts";

const FREE_LIMIT = RATE_LIMIT_PRESETS.free.caps.apiRequestsPerMinute;

// Tier lookups are cached because otherwise this middleware would add a
// Postgres read to every request — reintroducing, on the API side, the
// exact problem the bot's config cache exists to solve.
const TIER_CACHE_SECONDS = 120;

async function limitForGuild(guildId: string): Promise<number> {
  const key = `appealy:apilimit:tier:${guildId}`;

  const cached = await withRedis<string | null>((r) => r.get(key), null);
  if (cached !== null) return Number(cached) || FREE_LIMIT;

  const guild = await db.query.guilds.findFirst({
    where: eq(schema.guilds.id, BigInt(guildId)),
  });
  const limit = guild ? resolveEffectiveCaps(guild).apiRequestsPerMinute : FREE_LIMIT;

  await withRedis((r) => r.set(key, String(limit), "EX", TIER_CACHE_SECONDS), null);
  return limit;
}

/** Called from the billing routes after a plan change so a customer who
 * just paid for more throughput gets it immediately, not in two minutes. */
export async function invalidateApiLimitCache(guildId: string | bigint): Promise<void> {
  await withRedis((r) => r.del(`appealy:apilimit:tier:${guildId}`), 0);
}

export async function guildApiRateLimit(req: Request, res: Response, next: NextFunction) {
  const guildId = routeParams(req).guildId;
  if (!guildId) return next();

  const limit = await limitForGuild(guildId);
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `appealy:apilimit:${guildId}:${minuteBucket}`;

  const count = await withRedis(async (r) => {
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, 90); // outlive the window, don't leak
    return n;
  }, -1);

  // -1 means Redis is unavailable. Allow the request through.
  //
  // This is the opposite choice from the bot's billing caps, which fail
  // closed, and the difference is deliberate: the bot's caps meter what a
  // customer paid for, so failing open gives away product. This limit
  // protects our own API capacity, and when Redis is down that capacity is
  // already degraded — locking every customer out of the dashboard on top
  // of a cache outage turns one incident into two.
  if (count === -1) return next();

  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
  res.setHeader("X-RateLimit-Reset", String((minuteBucket + 1) * 60));

  if (count > limit) {
    const retryAfter = Math.ceil(((minuteBucket + 1) * 60_000 - Date.now()) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: "rate_limited",
      detail: `This server has used ${count} of its ${limit} allowed API requests this minute.`,
      limit,
      retryAfter,
    });
  }

  next();
}
