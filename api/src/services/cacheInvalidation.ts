// api/src/services/cacheInvalidation.ts
//
// The API is where guild config changes; the bot is where it's read on the
// hot path. The bot caches aggressively (bot/src/core/guildConfigCache.ts)
// for thirty minutes, which without this file would mean an admin saves a
// welcome message, tests it, and sees the old one for up to that long.
//
// That's a bad enough experience to be worth solving, and it's also the
// single most common way caching gets ripped back out of a project: it
// works, but it feels broken, so someone deletes it.
//
// So: tell the bot on every write, and it evicts that guild immediately.
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
 * Tells the bot to drop its cached config for this guild.
 *
 * Deliberately fire-and-forget and never throws: a failed cache
 * invalidation must not fail the write that already succeeded. The admin's
 * change IS saved; the worst outcome is that it takes up to 30 minutes to appear.
 * Turning that into a 500 would be strictly worse for the user.
 *
 * Two transports, because that worst case is long enough to be worth making
 * rare. Pub/sub alone can fail without a sound: the bot's subscriber only ever
 * reads and its socket has no keepalive, so if the connection dies without a
 * goodbye the bot never finds out, and every save after that waits out the TTL
 * until the next restart. The direct call is one hop on the same machine, over
 * the authenticated channel already open between the API and the bot (see
 * botBridge.ts). It reaches one bot, and there is only one by design: see the
 * top of deploy/vm/compose.yaml. Pub/sub stays for when the bot is too busy to
 * answer inside the bridge's timeout.
 *
 * With the in-memory substitute (see shared/lib/memoryRedis.ts) the API and bot
 * are separate processes holding separate copies of the shim, so a publish
 * reaches only this process and the direct call is all there is.
 */
export async function invalidateGuildCache(guildId: string | bigint): Promise<void> {
  const id = guildId.toString();
  await Promise.all([
    requestCacheInvalidate(id).catch(() => {}),
    useMemoryRedis(env.REDIS_URL)
      ? null
      : withRedis((r) => r.publish(INVALIDATION_CHANNEL, JSON.stringify({ guildId: id })), 0),
  ]);
}

/**
 * Express middleware that invalidates after any successful mutating
 * request on a guild-scoped route.
 *
 * Doing this centrally rather than adding a call to each of the ~40 write
 * handlers is the point: a per-handler approach works until someone adds
 * the 41st route and forgets, and the resulting bug — one config type that
 * takes minutes to apply while every other one is instant — is
 * maddening to track down.
 *
 * Hooks `res.on("finish")` so it only fires for 2xx responses; a rejected
 * write changed nothing and should not evict a warm cache.
 *
 * Only guild-scoped routes pass through here. A webhook has no :guildId, so one
 * that changes what the bot caches has to call invalidateGuildCache itself.
 * routes/paddleWebhook.ts doesn't yet, so a plan change takes up to the TTL to
 * reach the bot's caps. Payments are closed for now.
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
