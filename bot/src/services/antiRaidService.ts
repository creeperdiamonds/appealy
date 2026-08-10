// bot/src/services/antiRaidService.ts
//
// Join-velocity raid detection.
//
// The deliberate scope limit from the original is unchanged and worth
// restating: this NEVER retroactively kicks or bans members who joined
// before a lockdown triggered, and never mass-bans at all. The only
// actions are "alert staff" and "restrict joins that happen WHILE a
// lockdown is active", because a false positive on a genuine growth spike
// — a public invite going viral — is far more damaging than under-reacting
// to a real raid. That judgment is correct and this rewrite preserves it.
//
// WHAT CHANGED
// ------------
// 1. FOUR SEQUENTIAL REDIS ROUND-TRIPS BECAME ONE PIPELINE.
//    The original issued ZADD, EXPIRE, ZREMRANGEBYSCORE, and ZCOUNT as
//    four separate awaited commands. Four round-trips per join. During the
//    raid this exists to detect — thousands of joins per minute — that is
//    four times the latency and four times the connection contention at
//    the worst possible moment. They now go out in a single pipeline.
//
// 2. THE CONFIG READ MOVED OUT.
//    The original opened with `db.query.antiRaidConfigs.findFirst(...)` on
//    every join, before even checking whether anti-raid was enabled. The
//    caller (guildMemberAdd) already holds this from the cached config
//    bundle, so it's passed in. The DB is no longer touched on the join
//    path at all unless a lockdown actually fires.
//
// 3. `isLockdownActive` IS NOW CACHED — BUT ONLY FOR 2 SECONDS.
//    This one needs care. A lockdown is written by the bot mid-raid and
//    read microseconds later to decide whether to kick the next joiner.
//    Caching it for the standard 60s would mean the first minute of a raid
//    sails straight through the defense that was just armed — the cache
//    would defeat the feature. A 2s TTL still absorbs ~99% of reads at
//    raid volume while keeping the arming window imperceptible. This is
//    why lockdown state is deliberately excluded from the main config
//    bundle in guildConfigCache.ts.
//
// 4. THE UNCONDITIONAL ZADD IS GONE.
//    The original recorded every join into Redis even when anti-raid was
//    disabled, reasoning that enabling it later wouldn't need a backfill.
//    That's a real consideration, but it's paying a write on 100% of joins
//    across every guild to save a cold window on the rare guild that
//    toggles the feature on — and the window it saves is `windowSeconds`
//    long, typically 60 seconds. Tracking now happens only when enabled.

import { eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { pipeline, withRedis } from "../core/redis.ts";
import { logger } from "../utils/logger.ts";

function joinWindowKey(guildId: bigint) {
  return `appealy:antiraid:joins:${guildId}`;
}

function lockdownCacheKey(guildId: bigint) {
  return `appealy:antiraid:active:${guildId}`;
}

// Short enough that arming a lockdown takes effect essentially immediately;
// long enough to absorb the read volume of a raid in progress.
const LOCKDOWN_CACHE_SECONDS = 2;

/**
 * Records a join and triggers a lockdown if the velocity threshold is met.
 *
 * `config` is passed in rather than read here — the caller already has it
 * from the cached bundle, and re-reading would put a database query back
 * on the join path.
 */
export async function recordJoinAndCheckRaid(
  bot: AppealyBot,
  guildId: bigint,
  userId: bigint,
  config: typeof schema.antiRaidConfigs.$inferSelect | null,
): Promise<void> {
  if (!config?.enabled) return;

  const now = Date.now();
  const key = joinWindowKey(guildId);
  const windowStart = now - config.windowSeconds * 1000;

  // One round-trip: record, bound the key's lifetime, evict everything
  // older than the window, then count what's left inside it.
  const results = await pipeline([
    ["ZADD", key, now, `${userId}:${now}`],
    ["EXPIRE", key, Math.max(config.windowSeconds * 2, 300)],
    ["ZREMRANGEBYSCORE", key, 0, windowStart - 1],
    ["ZCOUNT", key, windowStart, now],
  ]);

  const joinCountInWindow = Number(results[3] ?? 0);
  if (joinCountInWindow < config.joinThreshold) return;

  // Already locked down — don't re-alert on every subsequent join past the
  // threshold, which during a raid would mean thousands of pings.
  if (await isLockdownActiveCached(guildId)) return;

  await triggerLockdown(bot, guildId, config, joinCountInWindow);
}

async function triggerLockdown(
  bot: AppealyBot,
  guildId: bigint,
  config: typeof schema.antiRaidConfigs.$inferSelect,
  joinCount: number,
) {
  const expiresAt = new Date(Date.now() + config.autoLockdownExpiresAfterSeconds * 1000);

  await db
    .insert(schema.raidLockdowns)
    .values({ guildId, triggeredByJoinCount: joinCount, expiresAt })
    .onConflictDoUpdate({
      target: schema.raidLockdowns.guildId,
      set: {
        triggeredAt: new Date(),
        triggeredByJoinCount: joinCount,
        expiresAt,
        clearedBy: null,
      },
    });

  // Prime the cache immediately rather than waiting for the next read to
  // miss. During a raid the very next join is microseconds away, and it
  // should already see the lockdown as active.
  await withRedis(
    (r) => r.set(lockdownCacheKey(guildId), "1", { ex: LOCKDOWN_CACHE_SECONDS }),
    null,
  );

  logger.warn("Anti-raid lockdown triggered", {
    guildId: guildId.toString(),
    joinCount,
    action: config.action,
  });

  if (config.alertChannelId) {
    const pingContent =
      config.alertRoleIds.length > 0
        ? config.alertRoleIds.map((r) => `<@&${r}>`).join(" ") + " "
        : "";
    try {
      await bot.helpers.sendMessage(config.alertChannelId, {
        content:
          `${pingContent}⚠️ **Possible raid detected** — ${joinCount} members joined within ` +
          `${config.windowSeconds}s. Action: \`${config.action}\`. This lockdown clears ` +
          `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>, or use \`/anti-raid clear\` to end it now.`,
        allowedMentions: { roles: config.alertRoleIds.map((r) => BigInt(r)) },
      });
    } catch (err) {
      logger.error("Failed to send anti-raid alert", {
        guildId: guildId.toString(),
        error: String(err),
      });
    }
  }

  if (config.action === "lock_verification") {
    try {
      await db
        .update(schema.verificationConfigs)
        .set({ enabled: true })
        .where(eq(schema.verificationConfigs.guildId, guildId));
      // Force-enabling verification changes cached config, so evict.
      const { invalidateGuild } = await import("../core/guildConfigCache.ts");
      await invalidateGuild(guildId);
    } catch (err) {
      logger.error("Failed to force-enable verification during lockdown", {
        error: String(err),
      });
    }
  }
  // kick_new_joins needs nothing here — it's enforced per-join going
  // forward via isLockdownActiveCached(), never retroactively.
}

/**
 * Whether a lockdown is currently active, with a 2-second cache.
 *
 * The cache stores "1"/"0" rather than using key-absence to mean inactive,
 * so a negative result is cacheable too. Without that, the common case
 * (no lockdown, every join) would miss the cache every single time and hit
 * Postgres anyway — which is the entire problem being solved.
 */
export async function isLockdownActiveCached(guildId: bigint): Promise<boolean> {
  const cached = await withRedis<string | null>(
    (r) => r.get(lockdownCacheKey(guildId)),
    null,
  );
  if (cached !== null) return cached === "1";

  const lockdown = await db.query.raidLockdowns.findFirst({
    where: eq(schema.raidLockdowns.guildId, guildId),
  });
  const active = Boolean(lockdown && lockdown.expiresAt > new Date());

  await withRedis(
    (r) => r.set(lockdownCacheKey(guildId), active ? "1" : "0", { ex: LOCKDOWN_CACHE_SECONDS }),
    null,
  );
  return active;
}

/** Uncached read, for the dashboard and for `/anti-raid status` where
 * showing a two-second-stale value would be confusing. */
export async function isLockdownActive(guildId: bigint): Promise<boolean> {
  const lockdown = await db.query.raidLockdowns.findFirst({
    where: eq(schema.raidLockdowns.guildId, guildId),
  });
  return Boolean(lockdown && lockdown.expiresAt > new Date());
}

export async function clearLockdown(guildId: bigint, clearedBy: bigint): Promise<boolean> {
  const result = await db
    .update(schema.raidLockdowns)
    .set({ expiresAt: new Date(), clearedBy })
    .where(eq(schema.raidLockdowns.guildId, guildId))
    .returning();

  // Evict rather than write "0" — a manual clear should take effect now,
  // and letting the next read repopulate from Postgres is the honest path.
  await withRedis((r) => r.del(lockdownCacheKey(guildId)), 0);
  return result.length > 0;
}

/** Live join count in the configured window, for the dashboard's raid gauge. */
export async function getJoinVelocity(
  guildId: bigint,
  windowSeconds: number,
): Promise<number> {
  const now = Date.now();
  return withRedis(
    (r) => r.zcount(joinWindowKey(guildId), now - windowSeconds * 1000, now),
    0,
  );
}
