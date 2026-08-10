// api/src/lib/redis.ts
//
// The API process previously had no Redis client at all, which is why
// several things that need shared state — the OAuth `state` store, guild
// permission caching, API rate limiting — were either in-process Maps
// (breaking the moment you run more than one API replica, which the README
// explicitly says you should) or simply absent.
//
// Uses `ioredis` because it reconnects on its own, exposes a real pipeline
// API, and its `Cluster` type is a drop-in if this ever needs to scale past
// a single Redis node.
//
// `lazyConnect` matters here: without it, importing this module opens a
// socket as a side effect, which makes `createApp()` untestable without a
// live Redis and turns a Redis outage at boot into a crash loop rather than
// degraded service.

import Redis from "ioredis";
import { env } from "../env.ts";

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false, // fail fast rather than queueing during an outage
  retryStrategy: (times) => Math.min(times * 200, 5_000),
});

let connectPromise: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (redis.status === "ready") return;
  if (!connectPromise) {
    connectPromise = redis.connect().catch((err) => {
      connectPromise = null;
      throw err;
    });
  }
  await connectPromise;
}

/**
 * Runs a Redis operation, returning `fallback` if Redis is unreachable.
 *
 * Every caller passes its fallback explicitly rather than inheriting a
 * default, because the right behavior differs per call site and burying
 * that decision in a shared helper is how a cache outage quietly becomes a
 * security or billing problem:
 *
 *   - Permission cache miss  -> fall back to asking Discord (slow, correct)
 *   - Rate limit check fails -> allow the request (an API outage shouldn't
 *                               also be a lockout; unlike the bot's billing
 *                               caps, this limit protects our own capacity,
 *                               which is already degraded anyway)
 *   - OAuth state lookup     -> reject the login (never weaken CSRF
 *                               protection to preserve availability)
 */
export async function withRedis<T>(
  fn: (r: Redis) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    await ensureConnected();
    return await fn(redis);
  } catch {
    return fallback;
  }
}

export async function redisHealthy(): Promise<boolean> {
  return withRedis(async (r) => {
    await r.ping();
    return true;
  }, false);
}
