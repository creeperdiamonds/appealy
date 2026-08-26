// api/src/services/cacheInvalidation.ts
//
// The API is where guild config changes; the bot is where it's read on the
// hot path. The bot caches aggressively (bot/src/core/guildConfigCache.ts)
// with a 60s L1 TTL, which without this file would mean an admin saves a
// welcome message, tests it, and sees the old one for up to a minute.
//
// That's a bad enough experience to be worth solving, and it's also the
// single most common way caching gets ripped back out of a project: it
// works, but it feels broken, so someone deletes it.
//
// So: publish a Redis message on every write, and every bot replica evicts
// that guild immediately.
//
// Pub/sub is at-most-once and drops messages when a subscriber is
// disconnected. That's acceptable here ONLY because the TTL still exists
// underneath. Pub/sub makes the common case instant; TTL bounds the worst
// case. Relying on either alone would be wrong — a system that depends on
// pub/sub for correctness is a system that goes stale silently.

import { withRedis } from "../lib/redis.ts";
import { useMemoryRedis } from "../../../shared/lib/memoryRedis.ts";
import { env } from "../env.ts";
import { requestCacheInvalidate } from "./botBridge.ts";

const INVALIDATION_CHANNEL = "appealy:cache:invalidate";

/**
 * Tells every bot replica to drop its cached config for this guild.
 *
 * Deliberately fire-and-forget and never throws: a failed cache
 * invalidation must not fail the write that already succeeded. The admin's
 * change IS saved; the worst outcome is that it takes up to 60s to appear.
 * Turning that into a 500 would be strictly worse for the user.
 *
 * Transport is chosen once per call, on whether REDIS_URL is the in-memory
 * substitute (see shared/lib/memoryRedis.ts). With the substitute, the API
 * and bot are separate processes holding separate copies of the shim, so
 * publish() below reaches only this process and the bot never hears it —
 * that is the bug this file exists to fix. The API and bot happen to share
 * one Cloud Run instance with an authenticated internal channel already open
 * between them (see botBridge.ts), so that channel carries the message
 * instead. Buying real Redis (Memorystore, ~$26/mo, plus a Serverless VPC
 * Access connector to reach it, ~$9/mo) would also fix this, but that is
 * roughly $420/year to solve a problem this free channel already solves, on
 * a product with one guild on it. Redis becomes the right answer again the
 * moment this runs as more than one bot instance — see the bridge call's
 * `.catch(() => {})` below, which is this same fire-and-forget contract
 * applied to the new transport.
 *
 * The single-instance bet is not merely an assumption: it is enforced in
 * deploy/service.yaml:58, `autoscaling.knative.dev/maxScale: "1"`. Raising
 * that annotation is what invalidates everything above, so change the two
 * together.
 */
export async function invalidateGuildCache(guildId: string | bigint): Promise<void> {
  if (useMemoryRedis(env.REDIS_URL)) {
    await requestCacheInvalidate(guildId.toString()).catch(() => {});
    return;
  }
  await withRedis(
    (r) => r.publish(INVALIDATION_CHANNEL, JSON.stringify({ guildId: guildId.toString() })),
    0,
  );
}

/**
 * Express middleware that invalidates after any successful mutating
 * request on a guild-scoped route.
 *
 * Doing this centrally rather than adding a call to each of the ~40 write
 * handlers is the point: a per-handler approach works until someone adds
 * the 41st route and forgets, and the resulting bug — one config type that
 * takes a minute to apply while every other one is instant — is
 * maddening to track down.
 *
 * Hooks `res.on("finish")` so it only fires for 2xx responses; a rejected
 * write changed nothing and should not evict a warm cache.
 */
export function invalidateOnWrite(
  req: { method: string; params: { guildId?: string } },
  res: { statusCode: number; on: (e: string, cb: () => void) => void },
  next: () => void,
) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  const guildId = req.params.guildId;
  if (!guildId) return next();

  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      void invalidateGuildCache(guildId);
    }
  });

  next();
}
