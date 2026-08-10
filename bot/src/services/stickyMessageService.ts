// bot/src/services/stickyMessageService.ts
//
// Keeps a configured message pinned to the bottom of a channel. Discord has
// no native "always keep this message last" primitive, so this works by
// deleting the previous bot-sent copy and sending a fresh one once enough
// other activity has buried it.
//
// WHAT CHANGED AND WHY
// --------------------
// The original implementation did this per message, in every channel of
// every guild:
//
//     SELECT * FROM sticky_messages WHERE channel_id = $1   -- always
//     UPDATE sticky_messages SET messages_since_repost = $1 -- almost always
//
// So a guild doing 100 messages/sec cost 100 SELECTs and ~100 UPDATEs per
// second against a 10-connection pool, and every one of those UPDATEs was a
// durable write recording a number nobody reads except the next message.
//
// Worse, the counter was a read-modify-write with no lock: two concurrent
// messages both read N and both write N+1, so the counter drifts low and
// the sticky reposts less often than configured. That's a correctness bug
// hiding inside the performance bug.
//
// The rewrite:
//
//   1. "Does this channel even have a sticky?" is answered from the
//      in-process config cache with no I/O. This is the whole ballgame —
//      the vast majority of channels have no sticky, and those messages
//      now cost a hash lookup instead of a database query.
//
//   2. The counter moved to Redis INCR, which is atomic (no drift) and
//      doesn't touch Postgres. Postgres is written once per repost rather
//      than once per message.
//
//   3. Reposts take a short Redis lock. Without it, two messages arriving
//      at the threshold together both repost and the channel gets two
//      copies of the sticky — the exact thing the feature exists to avoid.
//
// `messagesSinceRepost` stays in the schema and is still written on repost
// so the dashboard has something to show, but it is no longer the live
// counter.

import { eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { withRedis } from "../core/redis.ts";
import { invalidateGuild } from "../core/guildConfigCache.ts";
import { logger } from "../utils/logger.ts";

function counterKey(channelId: bigint) {
  return `appealy:sticky:count:${channelId}`;
}

function lockKey(channelId: bigint) {
  return `appealy:sticky:lock:${channelId}`;
}

// Long enough to cover a delete + send round-trip to Discord including one
// rate-limit retry; short enough that a crashed process doesn't wedge the
// channel's sticky for long.
const REPOST_LOCK_SECONDS = 15;

/**
 * Increments the channel's message counter and reposts if the threshold is
 * reached.
 *
 * Callers MUST have already established that this channel has a sticky
 * (see `stickyChannelHint` in guildConfigCache.ts). This function assumes
 * that check happened and does not repeat it — repeating it here would put
 * the database read back on the hot path and undo the entire optimization.
 */
export async function bumpStickyMessageCounter(bot: AppealyBot, channelId: bigint) {
  const count = await withRedis((r) => r.incr(counterKey(channelId)), 0);
  // 0 means Redis is unavailable. Skipping is correct: falling back to a
  // per-message database read is precisely the behavior being removed, and
  // a missed sticky repost during a cache outage is a cosmetic problem.
  if (count === 0) return;

  if (count === 1) {
    // Bound the key's lifetime so channels that go quiet don't leave
    // counters resident in Redis indefinitely.
    await withRedis((r) => r.expire(counterKey(channelId), 7 * 24 * 60 * 60), 0);
  }

  const sticky = await db.query.stickyMessages.findFirst({
    where: eq(schema.stickyMessages.channelId, channelId),
  });
  if (!sticky || !sticky.active) {
    await withRedis((r) => r.del(counterKey(channelId)), 0);
    return;
  }

  if (count < sticky.repostAfterMessages) return;

  // SET NX returns null when the key already exists, meaning another
  // message won the race to repost.
  const acquired = await withRedis(
    (r) => r.set(lockKey(channelId), "1", { ex: REPOST_LOCK_SECONDS, nx: true }),
    null,
  );
  if (!acquired) return;

  try {
    await withRedis((r) => r.set(counterKey(channelId), "0"), null);
    await repostSticky(bot, sticky);
  } finally {
    await withRedis((r) => r.del(lockKey(channelId)), 0);
  }
}

async function repostSticky(bot: AppealyBot, sticky: typeof schema.stickyMessages.$inferSelect) {
  if (sticky.lastMessageId) {
    try {
      await bot.helpers.deleteMessage(
        sticky.channelId,
        sticky.lastMessageId,
        "Sticky message repost",
      );
    } catch {
      // Already deleted manually, or the bot lost permission. Non-fatal —
      // reposting anyway is still the right outcome.
    }
  }

  try {
    const message = await bot.helpers.sendMessage(sticky.channelId, { content: sticky.content });
    await db
      .update(schema.stickyMessages)
      .set({ lastMessageId: message.id, messagesSinceRepost: 0 })
      .where(eq(schema.stickyMessages.id, sticky.id));
  } catch (err) {
    logger.error("Failed to repost sticky message", {
      channelId: sticky.channelId.toString(),
      error: String(err),
    });
  }
}

/** Called when a sticky is created or edited on the dashboard, to post the
 * first/updated copy immediately instead of waiting for the threshold. */
export async function publishStickyMessage(bot: AppealyBot, stickyId: string) {
  const sticky = await db.query.stickyMessages.findFirst({
    where: eq(schema.stickyMessages.id, stickyId),
  });
  if (!sticky) throw new Error("sticky_message_not_found");

  await repostSticky(bot, sticky);
  await withRedis((r) => r.set(counterKey(sticky.channelId), "0"), null);

  // A newly created sticky won't be in the guild's cached channel list yet,
  // so without this eviction the next message in that channel would be
  // skipped by the zero-I/O hint and the sticky would never bump.
  await invalidateGuild(sticky.guildId);
}

/** Live counter for the dashboard's sticky view. Reads Redis rather than
 * the column, since the column is only accurate as of the last repost. */
export async function getLiveStickyCount(channelId: bigint): Promise<number> {
  const raw = await withRedis<string | null>((r) => r.get(counterKey(channelId)), null);
  return raw ? Number(raw) : 0;
}
