// bot/src/core/guildConfigCache.ts
//
// THE central scaling fix for the bot process.
//
// The problem this solves
// -----------------------
// Every per-event handler in this bot read its config straight from
// Postgres, once per event, with no cache:
//
//   messageCreate    -> 1 SELECT on stickyMessages, for EVERY message in
//                       EVERY guild, plus 1 UPDATE to bump a counter.
//   guildMemberAdd   -> 4 sequential SELECTs (antiRaidConfigs,
//                       raidLockdowns, verificationConfigs,
//                       welcomerConfigs) for EVERY join.
//   rateLimitService -> 1 SELECT on guilds for EVERY submission, ticket
//                       open, and giveaway entry.
//
// The bot's Postgres pool is `max: 10` (bot/src/db/client.ts). A single
// busy guild can produce hundreds of messages per second; a few hundred
// guilds produce thousands. The pool saturates, queries queue, and the
// gateway event loop backs up behind them — at which point Discord starts
// dropping the bot's shard for failing to heartbeat, which looks like a
// random disconnect rather than what it is: database backpressure.
//
// The insight is that all of this data is read constantly and written
// almost never. A guild's welcomer config changes when an admin edits it
// on the dashboard — maybe monthly. It is read on every single join.
// That is a textbook cache.
//
// Design
// ------
// Three tiers, checked in order:
//
//   L1  in-process Map, 60s TTL     -> ~0.001ms, no I/O at all
//   L2  Redis, 300s TTL             -> ~0.5ms, shared across bot replicas
//   L3  Postgres                    -> the system of record
//
// L1 is what actually carries the load. L2 exists so that a bot restart,
// or a second replica, doesn't stampede Postgres with cold-cache reads.
//
// Invalidation
// ------------
// Pull-based TTL expiry alone would mean up to 60s of staleness after a
// dashboard edit, which is a bad experience — an admin changes a welcome
// message, tests it, and it's still the old one. So the API publishes to
// a Redis channel on every config write and every bot replica evicts that
// guild's entry immediately (see `subscribeToInvalidations` below, and
// api/src/services/cacheInvalidation.ts on the other side).
//
// Pub/sub is fire-and-forget and can drop messages; that's fine here
// precisely BECAUSE the TTL also exists. Pub/sub makes the common case
// instant, TTL guarantees the worst case is bounded. Neither is trusted
// alone.
//
// A note on what is deliberately NOT cached
// -----------------------------------------
// `raidLockdowns` is read on the join path but is NOT part of this bundle.
// A lockdown is written by the bot itself mid-raid and read microseconds
// later to decide whether to kick the next joiner; a 60s stale read would
// mean the first minute of a raid sails straight through the defense that
// was just armed. It gets its own short-TTL Redis-only cache
// (`isLockdownActiveCached`) with a 2s TTL, which still removes ~99% of
// the DB reads during a raid without introducing that window.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { getRedis, withRedis } from "./redis.ts";
import { logger } from "../utils/logger.ts";

const L1_TTL_MS = 60_000;
const L2_TTL_SECONDS = 300;
const INVALIDATION_CHANNEL = "appealy:cache:invalidate";

/** Everything the per-event hot paths need for one guild, fetched together. */
export interface GuildConfigBundle {
  guild: typeof schema.guilds.$inferSelect | null;
  antiRaid: typeof schema.antiRaidConfigs.$inferSelect | null;
  verification: typeof schema.verificationConfigs.$inferSelect | null;
  welcomer: typeof schema.welcomerConfigs.$inferSelect | null;
  /** Channel IDs (as strings) in this guild that have an ACTIVE sticky
   * message. Almost always empty, which is exactly why caching it is so
   * effective — see stickyMessageService.ts. */
  stickyChannelIds: string[];
  cachedAt: number;
}

interface L1Entry {
  bundle: GuildConfigBundle;
  expiresAt: number;
}

const l1 = new Map<string, L1Entry>();

// Coalesces concurrent misses for the same guild into one DB read. Without
// this, a burst of 50 joins for a cold guild fires 50 identical queries.
const inFlight = new Map<string, Promise<GuildConfigBundle>>();

function l2Key(guildId: bigint | string) {
  return `appealy:cfg:${guildId}`;
}

// ---------------------------------------------------------------------------
// bigint/Date are not JSON-serializable, so L2 needs an explicit codec.
// Doing this by hand rather than reaching for a library keeps the failure
// mode obvious: if a new bigint column is added to one of these tables and
// isn't listed here, it round-trips as a string and the type error shows up
// at the call site instead of silently comparing wrong at runtime.
// ---------------------------------------------------------------------------

function serialize(bundle: GuildConfigBundle): string {
  return JSON.stringify(bundle, (_key, value) =>
    typeof value === "bigint" ? { __bigint: value.toString() } : value,
  );
}

function deserialize(raw: string): GuildConfigBundle {
  return JSON.parse(raw, (_key, value) => {
    if (value && typeof value === "object" && "__bigint" in value) {
      return BigInt((value as { __bigint: string }).__bigint);
    }
    // Drizzle returns timestamptz columns as Date; JSON turns them into
    // ISO strings. Rehydrate anything that looks like one so callers can
    // keep doing `config.expiresAt > new Date()` without special-casing
    // whether the value came from cache or from the database.
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) {
      return new Date(value);
    }
    return value;
  });
}

async function loadFromDatabase(guildId: bigint): Promise<GuildConfigBundle> {
  // One round-trip's worth of parallel queries rather than four sequential
  // awaits. postgres.js pipelines these over the same connection, so the
  // wall-clock cost is roughly one query, not four.
  const [guild, antiRaid, verification, welcomer, stickies] = await Promise.all([
    db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) }),
    db.query.antiRaidConfigs.findFirst({ where: eq(schema.antiRaidConfigs.guildId, guildId) }),
    db.query.verificationConfigs.findFirst({
      where: eq(schema.verificationConfigs.guildId, guildId),
    }),
    db.query.welcomerConfigs.findFirst({ where: eq(schema.welcomerConfigs.guildId, guildId) }),
    db
      .select({ channelId: schema.stickyMessages.channelId })
      .from(schema.stickyMessages)
      .where(eq(schema.stickyMessages.guildId, guildId)),
  ]);

  return {
    guild: guild ?? null,
    antiRaid: antiRaid ?? null,
    verification: verification ?? null,
    welcomer: welcomer ?? null,
    stickyChannelIds: stickies.map((s) => s.channelId.toString()),
    cachedAt: Date.now(),
  };
}

/** Returns the guild's cached config bundle, loading it if absent. */
export async function getGuildConfig(guildId: bigint): Promise<GuildConfigBundle> {
  const key = guildId.toString();

  const hit = l1.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.bundle;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const load = (async (): Promise<GuildConfigBundle> => {
    const cached = await withRedis<string | null>((r) => r.get(l2Key(guildId)), null);
    if (cached) {
      try {
        const bundle = deserialize(cached);
        l1.set(key, { bundle, expiresAt: Date.now() + L1_TTL_MS });
        return bundle;
      } catch (err) {
        // A schema change can leave an undeserializable payload behind.
        // Fall through to Postgres rather than failing the event.
        logger.warn("Discarding unreadable cached guild config", {
          guildId: key,
          error: String(err),
        });
      }
    }

    const bundle = await loadFromDatabase(guildId);
    l1.set(key, { bundle, expiresAt: Date.now() + L1_TTL_MS });
    await withRedis(
      (r) => r.set(l2Key(guildId), serialize(bundle), { ex: L2_TTL_SECONDS }),
      null,
    );
    return bundle;
  })();

  inFlight.set(key, load);
  try {
    return await load;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Zero-I/O check for whether a channel has a sticky message.
 *
 * This is the single highest-leverage function in the file. It is called
 * on every message the bot sees. It returns `false` for the overwhelming
 * majority of channels without touching Redis or Postgres — the L1 map
 * lookup is a hash probe on already-resident memory.
 *
 * Returns `null` (not `false`) when the guild isn't in L1 yet, so the
 * caller can decide whether a cache-warming await is worth it on that
 * path. See messageCreate.ts, which chooses to warm it once and then skip
 * every subsequent message for that guild.
 */
export function stickyChannelHint(guildId: bigint, channelId: bigint): boolean | null {
  const hit = l1.get(guildId.toString());
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return hit.bundle.stickyChannelIds.includes(channelId.toString());
}

/** Drops a guild from every cache tier. Called on dashboard writes. */
export async function invalidateGuild(guildId: bigint | string): Promise<void> {
  l1.delete(guildId.toString());
  await withRedis((r) => r.del(l2Key(guildId)), 0);
}

/**
 * Subscribes to invalidation messages published by the API when an admin
 * saves a config change, so every bot replica evicts immediately rather
 * than waiting out the TTL.
 *
 * Uses its own connection because Redis puts a subscriber connection into
 * subscribe mode, where it can't serve ordinary commands — sharing the
 * main client here would break every other Redis call in the process.
 */
export async function subscribeToInvalidations(): Promise<void> {
  try {
    const { connect } = await import("redis");
    const { env } = await import("./env.ts");
    const url = new URL(env.REDIS_URL);
    const sub = await connect({
      hostname: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
    });

    const subscription = await sub.subscribe(INVALIDATION_CHANNEL);
    logger.info("Subscribed to cache invalidations", { channel: INVALIDATION_CHANNEL });

    (async () => {
      for await (const { message } of subscription.receive()) {
        try {
          const { guildId } = JSON.parse(message) as { guildId: string };
          if (guildId) {
            l1.delete(guildId);
            await withRedis((r) => r.del(l2Key(guildId)), 0);
          }
        } catch (err) {
          logger.warn("Malformed cache invalidation message", { error: String(err) });
        }
      }
    })();
  } catch (err) {
    // Non-fatal by design. Without pub/sub the caches still expire on their
    // own TTL, so the bot stays correct and merely gets slower to reflect
    // dashboard edits. Refusing to boot over this would turn a degraded
    // experience into an outage.
    logger.error("Cache invalidation subscriber failed to start; falling back to TTL only", {
      error: String(err),
    });
  }
}

/** Cache statistics, surfaced on the bot's /internal/health endpoint so the
 * dashboard can show whether the cache is actually doing its job. */
export function cacheStats() {
  let live = 0;
  const now = Date.now();
  for (const entry of l1.values()) if (entry.expiresAt > now) live++;
  return { l1Entries: l1.size, l1Live: live, inFlightLoads: inFlight.size };
}

/** Evicts expired L1 entries. The Map would otherwise grow to one entry per
 * guild the bot has ever seen and never shrink — on a large fleet that's a
 * slow leak rather than a bounded cache. */
export function pruneL1(): number {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of l1) {
    if (entry.expiresAt <= now) {
      l1.delete(key);
      removed++;
    }
  }
  return removed;
}
