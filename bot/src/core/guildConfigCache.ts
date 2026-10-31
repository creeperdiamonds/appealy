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
// Two tiers, checked in order:
//
//   L1  in-process Map, 5 minute TTL  -> ~0.001ms, no I/O at all
//   L2  Postgres                      -> the system of record
//
// There used to be a Redis tier between them, for a bot restart or a second
// replica. It cost more than it saved: its 300s TTL started when a load did, so
// a longer-lived L1 entry would outlast it, and every load paid a GET that missed
// and a SET nobody would read. On a simulated 50 servers (scripts/sim) that was
// most of the bot's Redis traffic, and the free Upstash plan allows about 11
// commands a minute. A restart costs a few lazily-spread queries per active guild
// now, and there is no second replica (see the top of deploy/vm/compose.yaml);
// if one ever does, each keeps its own L1 and the invalidation below reaches both.
//
// Invalidation
// ------------
// Pull-based TTL expiry alone would mean up to five minutes of staleness after
// a dashboard edit, which is a bad experience — an admin changes a welcome
// message, tests it, and it's still the old one. So the API publishes to
// a Redis channel on every config write and every bot replica evicts that
// guild's entry immediately (see `subscribeToInvalidations` below, and
// api/src/services/cacheInvalidation.ts on the other side).
//
// Pub/sub is fire-and-forget and can drop messages; that's fine here
// precisely BECAUSE the TTL also exists. Pub/sub makes the common case
// instant, TTL guarantees the worst case is bounded. Neither is trusted
// alone. That bound was six minutes with the Redis tier, since a stale copy
// there could refill L1; it is five now.
//
// A note on what is deliberately NOT cached
// -----------------------------------------
// `raidLockdowns` is read on the join path but is NOT part of this bundle.
// A lockdown is written by the bot itself mid-raid and read microseconds
// later to decide whether to kick the next joiner; a stale read would
// mean the start of a raid sails straight through the defense that was just
// armed. It gets its own short-TTL Redis-only cache
// (`isLockdownActiveCached`) with a 2s TTL, which still removes ~99% of
// the DB reads during a raid without introducing that window.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { connectOptionsFromUrl } from "./redis.ts";
import { logger } from "../utils/logger.ts";

const L1_TTL_MS = 5 * 60_000;
const INVALIDATION_CHANNEL = "appealy:cache:invalidate";

/** Everything the per-event hot paths need for one guild, fetched together. */
export interface GuildConfigBundle {
  guild: typeof schema.guilds.$inferSelect | null;
  antiRaid: typeof schema.antiRaidConfigs.$inferSelect | null;
  verification: typeof schema.verificationConfigs.$inferSelect | null;
  welcomer: typeof schema.welcomerConfigs.$inferSelect | null;
  /** Ban, timeout and restriction appeal settings — read on every guildMemberUpdate. */
  appeal: typeof schema.appealConfigs.$inferSelect | null;
  /**
   * Text moderation command settings (prefix, on/off, roles). Read for every
   * message that could be a command. Null means the defaults.
   */
  moderation: typeof schema.moderationConfigs.$inferSelect | null;
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

async function loadFromDatabase(guildId: bigint): Promise<GuildConfigBundle> {
  // One after another, on purpose. These used to run in parallel on the belief
  // that postgres.js pipelines them over one connection, but it only does that
  // once the pool is full: below that, each query with no idle connection opens
  // a new one. So every load took the pool to its maximum, and a new connection
  // costs far more than these seven queries do (through the Cloud SQL proxy, a
  // TLS handshake and a password exchange, plus a process on the database).
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  const antiRaid = await db.query.antiRaidConfigs.findFirst({ where: eq(schema.antiRaidConfigs.guildId, guildId) });
  const verification = await db.query.verificationConfigs.findFirst({
    where: eq(schema.verificationConfigs.guildId, guildId),
  });
  const welcomer = await db.query.welcomerConfigs.findFirst({ where: eq(schema.welcomerConfigs.guildId, guildId) });
  const appeal = await db.query.appealConfigs.findFirst({ where: eq(schema.appealConfigs.guildId, guildId) });
  const stickies = await db
    .select({ channelId: schema.stickyMessages.channelId })
    .from(schema.stickyMessages)
    .where(eq(schema.stickyMessages.guildId, guildId));
  const moderation = await db.query.moderationConfigs.findFirst({ where: eq(schema.moderationConfigs.guildId, guildId) });

  return {
    guild: guild ?? null,
    antiRaid: antiRaid ?? null,
    verification: verification ?? null,
    welcomer: welcomer ?? null,
    appeal: appeal ?? null,
    stickyChannelIds: stickies.map((s) => s.channelId.toString()),
    moderation: moderation ?? null,
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
    const bundle = await loadFromDatabase(guildId);
    l1.set(key, { bundle, expiresAt: Date.now() + L1_TTL_MS });
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

/** Drops a guild from the cache. Called on dashboard writes. */
export function invalidateGuild(guildId: bigint | string): void {
  l1.delete(guildId.toString());
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
    // No pub/sub without a real Redis. useMemoryRedis() treats "", "memory"
    // and "memory://" as the in-process substitute, and new URL("memory")
    // throws — which surfaced in production as
    // `TypeError: Invalid URL: 'memory'` inside a catch block that reported
    // it as the subscriber failing, rather than as the configuration it is.
    //
    // Returning early is correct, not a workaround: the substitute is
    // per-process, so there is no second process to receive a message from.
    // Callers already fall back to TTL expiry, which is exactly right here.
    const { useMemoryRedis } = await import("../../../shared/lib/memoryRedis.ts");
    if (useMemoryRedis(env.REDIS_URL)) {
      logger.info(
        "Cache invalidation subscriber skipped: REDIS_URL is the in-memory substitute, so caches expire on TTL alone.",
      );
      return;
    }
    const url = new URL(env.REDIS_URL);
    // TLS comes from the scheme — see connectOptionsFromUrl.
    const sub = await connect(connectOptionsFromUrl(url));

    const subscription = await sub.subscribe(INVALIDATION_CHANNEL);
    logger.info("Subscribed to cache invalidations", { channel: INVALIDATION_CHANNEL });

    (async () => {
      for await (const { message } of subscription.receive()) {
        try {
          const { guildId } = JSON.parse(message) as { guildId: string };
          if (guildId) l1.delete(guildId);
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
