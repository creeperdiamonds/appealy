// bot/src/core/redis.ts
//
// ONE Redis connection for the whole bot process.
//
// Before this file, `rateLimitService.ts` and `antiRaidService.ts` each did
// their own module-level `await connect(...)`. That's two problems, not one:
//
//   1. Two TCP connections where one would do, each opened as a side effect
//      of importing the module — so import order silently determined
//      connection order, and a Redis outage at boot threw from inside an
//      import rather than from anywhere you could catch it.
//   2. Top-level `await` in a module makes every importer async. Any file
//      that transitively imports one of those services became an async
//      module, which pushes work into the microtask queue during startup
//      and makes failures surface as unhandled rejections with no stack
//      pointing at the real cause.
//
// This module exports a lazily-connected singleton instead. Nothing
// connects at import time; the first caller connects, everyone else awaits
// the same promise. A dropped connection reconnects on next use rather
// than wedging the process.
//
// It also exposes `pipeline()`, which matters more than it looks: the hot
// paths in this bot issue 2-4 sequential Redis commands per event
// (ZADD then EXPIRE then ZREMRANGEBYSCORE then ZCOUNT in antiRaidService).
// Sequential means 4 network round-trips. Pipelined means 1. At a few
// thousand joins/sec during a raid — exactly when you need this to be
// fast — that is the difference between keeping up and falling behind.

import { connect, type Redis } from "redis";
import { env } from "./env.ts";
import { logger } from "../utils/logger.ts";
import { MemoryRedis, useMemoryRedis, MEMORY_REDIS_WARNING } from "../../../shared/lib/memoryRedis.ts";

let client: Redis | null = null;
let connecting: Promise<Redis> | null = null;

async function openConnection(): Promise<Redis> {
  // POC mode: no Redis container. Everything this bot keeps in Redis is
  // reconstructible, so an in-process substitute is enough to run end to end
  // — see shared/lib/memoryRedis.ts for exactly where that stops being true.
  if (useMemoryRedis(env.REDIS_URL)) {
    logger.warn(MEMORY_REDIS_WARNING);
    return new MemoryRedis("bot") as unknown as Redis;
  }

  const url = new URL(env.REDIS_URL);
  const redis = await connect({
    hostname: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
  });
  logger.info("Redis connected", { host: url.hostname, port: url.port || "6379" });
  return redis;
}

/** Returns the shared client, connecting on first use. Concurrent callers
 * during startup all await the same in-flight connection rather than each
 * opening their own. */
export async function getRedis(): Promise<Redis> {
  if (client) return client;
  if (!connecting) {
    connecting = openConnection()
      .then((c) => {
        client = c;
        connecting = null;
        return c;
      })
      .catch((err) => {
        connecting = null;
        throw err;
      });
  }
  return connecting;
}

/**
 * Runs `fn` against Redis, returning `fallback` if Redis is unavailable
 * instead of throwing.
 *
 * This is deliberate and worth being explicit about: Redis here holds
 * counters and caches, never the system of record. Postgres is the system
 * of record. If Redis is down, the correct behavior for a Discord bot is
 * to keep serving interactions with slightly stale caps rather than to
 * start throwing errors at every user in every guild. A cache outage
 * should degrade throughput accounting, not availability.
 *
 * The one place this trade-off does NOT apply is rate limiting, where
 * failing open means the caps you bill for stop being enforced. That
 * call site passes an explicit fallback that reflects the choice it wants
 * rather than inheriting a default — see rateLimitService.ts.
 */
export async function withRedis<T>(fn: (r: Redis) => Promise<T>, fallback: T): Promise<T> {
  try {
    const r = await getRedis();
    return await fn(r);
  } catch (err) {
    logger.warn("Redis operation failed, using fallback", { error: String(err) });
    // Drop the handle so the next call attempts a fresh connection rather
    // than reusing one that may be half-open.
    client = null;
    return fallback;
  }
}

/**
 * Executes several commands in a single round-trip.
 *
 * Deno's redis client exposes `tx()`/`pipeline()` depending on version;
 * this wraps whichever exists so call sites don't have to care, and falls
 * back to sequential execution if neither is present rather than failing.
 * Sequential is still correct — just slower — so a library version bump
 * degrades performance instead of breaking the bot.
 */
export async function pipeline(
  commands: Array<[string, ...(string | number)[]]>,
): Promise<unknown[]> {
  return withRedis(async (r) => {
    const anyR = r as unknown as {
      pipeline?: () => { flush: () => Promise<unknown[]> } & Record<string, unknown>;
      tx?: () => { flush: () => Promise<unknown[]> } & Record<string, unknown>;
      sendCommand: (cmd: string, ...args: (string | number)[]) => Promise<unknown>;
    };

    const batch = anyR.pipeline?.() ?? anyR.tx?.();
    if (batch && typeof batch.flush === "function") {
      for (const [cmd, ...args] of commands) {
        const fn = batch[cmd.toLowerCase()] as
          | ((...a: (string | number)[]) => unknown)
          | undefined;
        if (fn) fn.call(batch, ...args);
        else await anyR.sendCommand(cmd, ...args);
      }
      return await batch.flush();
    }

    const results: unknown[] = [];
    for (const [cmd, ...args] of commands) {
      results.push(await anyR.sendCommand(cmd, ...args));
    }
    return results;
  }, []);
}
