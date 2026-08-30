// bot/src/core/scheduler.ts
//
// WHAT WAS WRONG WITH THE ORIGINAL
// --------------------------------
// The README was honest that "the in-process scheduler assumes a single bot
// instance", but the failure mode is worse than the note suggests, and it
// bites before you ever intentionally run a second replica:
//
// 1. NO OVERLAP GUARD. `setInterval(async () => ...)` does not wait for the
//    previous callback to finish. If a tick takes longer than 30s — which
//    it will, the moment there are enough due polls and giveaways to
//    process, since they were handled sequentially — a second tick starts
//    on top of it. They then race each other to publish the same poll,
//    because "select due" and "mark published" were not atomic. The result
//    is duplicate poll messages, and it gets worse under load rather than
//    better: more work per tick means more overlap means more duplicates.
//
// 2. NO DISTRIBUTED LOCK. Two replicas — or one replica during a rolling
//    deploy, where old and new run concurrently for a few seconds — both
//    end giveaways and both pick winners.
//
// 3. SEQUENTIAL EVERYTHING. `closeDuePolls` looped over due polls awaiting
//    an UPDATE then a Discord edit for each, one at a time. 200 due polls
//    is 400 serialized round-trips.
//
// 4. ERRORS ATE THE WHOLE TICK. One failing giveaway threw out of the
//    `try` and skipped everything after it, including work unrelated to it.
//
// WHAT THIS DOES INSTEAD
// ----------------------
// - A Redis lock, held per task, with a TTL shorter than the work is
//   allowed to take. Only one process runs a given task per tick, and if
//   the holder dies the lock expires rather than deadlocking.
// - An `isRunning` guard so a slow tick is skipped rather than stacked.
// - Batched database writes and bounded-concurrency Discord calls.
// - Each task isolated, so one failure doesn't cancel the others.
// - A durable job queue (`scheduled_jobs`) draining alongside, which is
//   what replaced the per-member `setTimeout` calls in guildMemberAdd.

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AppealyBot } from "./client.ts";
import { db, schema } from "../db/client.ts";
import { withRedis } from "./redis.ts";
import { pruneL1 } from "./guildConfigCache.ts";
import { publishDuePolls } from "../services/pollService.ts";
import { endDueGiveaways } from "../services/giveawayService.ts";
import { logger } from "../utils/logger.ts";

const TICK_MS = 30_000;

/** Identifies this process in claimed job rows, so an abandoned claim can
 * be attributed when debugging. */
const WORKER_ID = `${Deno.hostname?.() ?? "bot"}-${crypto.randomUUID().slice(0, 8)}`;

/** How long a claimed-but-unfinished job stays invisible before another
 * worker may retry it. Must exceed the slowest plausible job. */
const CLAIM_VISIBILITY_MS = 5 * 60_000;

const MAX_ATTEMPTS = 3;

/**
 * Whether the history purge may actually delete. OFF by default, deliberately.
 *
 * The purge had never run — see enqueueHistoryPurges — so the first run on a
 * live database is not a routine tick, it is a one-shot deletion of however
 * much reviewed history accumulated over the whole time retention was not
 * being enforced. Free tier is 30 days, so on an old guild that is nearly
 * everything, irreversibly, with answers cascading.
 *
 * Enforcing retention is the documented behaviour (site/privacy.html) and it
 * should be enforced. But turning it on ought to be a decision somebody makes
 * having seen the numbers, not a side effect of deploying. While disabled the
 * purge still runs and logs exactly what it WOULD delete, so those numbers
 * exist before anyone commits to them.
 */
const HISTORY_PURGE_ENABLED =
  (Deno.env.get("HISTORY_PURGE_ENABLED") ?? "false").toLowerCase() === "true";

/**
 * Rows one guild's purge deletes per run.
 *
 * The backlog then drains over several days rather than in a single very
 * long-locking DELETE with a correspondingly large WAL write. Once caught up,
 * a day's expiries are far below this and it never binds.
 */
const HISTORY_PURGE_BATCH = Math.max(
  1,
  Number(Deno.env.get("HISTORY_PURGE_BATCH") ?? "500") || 500,
);

/** Cap on simultaneous Discord REST calls from scheduled work. The library
 * has its own rate limiter, but firing 500 edits at once still builds a
 * queue that delays live interactions behind batch work. Live user actions
 * should never wait on a scheduler backlog. */
const REST_CONCURRENCY = 8;

let isRunning = false;

export function startScheduler(bot: AppealyBot) {
  setInterval(() => {
    if (isRunning) {
      logger.warn("Skipping scheduler tick — previous tick still running");
      return;
    }
    isRunning = true;
    void runTick(bot).finally(() => {
      isRunning = false;
    });
  }, TICK_MS);

  logger.info("Scheduler started", { tickMs: TICK_MS, workerId: WORKER_ID });
}

async function runTick(bot: AppealyBot) {
  // allSettled, not all: a thrown giveaway must not cancel poll closing.
  await Promise.allSettled([
    withLock("polls:publish", 25, () => publishDuePolls(bot)),
    withLock("polls:close", 25, () => closeDuePolls(bot)),
    withLock("giveaways:end", 25, () => endDueGiveaways(bot)),
    withLock("jobs:drain", 25, () => drainScheduledJobs(bot)),
    withLock("history:enqueue", 25, () => enqueueHistoryPurges()),
  ]);

  const pruned = pruneL1();
  if (pruned > 0) logger.debug("Pruned expired config cache entries", { pruned });
}

/**
 * Runs `fn` only if this process can acquire the named lock.
 *
 * TTL is in seconds and should be slightly under the tick interval — if
 * the work genuinely takes longer than a tick, letting the lock expire so
 * the next tick can pick up is better than holding it and stalling
 * indefinitely.
 *
 * If Redis is unavailable, `withRedis` returns the `null` fallback and the
 * task is SKIPPED rather than run unlocked. That's the deliberate choice:
 * a missed tick delays a poll by 30 seconds, whereas running unlocked
 * across replicas double-posts messages and picks giveaway winners twice.
 * Delay is recoverable; duplicate winners are not.
 */
async function withLock(name: string, ttlSeconds: number, fn: () => Promise<unknown>) {
  const key = `appealy:sched:lock:${name}`;
  const token = crypto.randomUUID();

  const acquired = await withRedis(
    (r) => r.set(key, token, { ex: ttlSeconds, mode: "NX" }),
    null,
  );
  if (!acquired) return;

  try {
    await fn();
  } catch (err) {
    logger.error("Scheduler task failed", { task: name, error: String(err) });
  } finally {
    // Only release if we still hold it — if the TTL expired mid-run and
    // another worker acquired it, deleting would release *their* lock.
    await withRedis(async (r) => {
      const current = await r.get(key);
      if (current === token) await r.del(key);
      return null;
    }, null);
  }
}

async function closeDuePolls(bot: AppealyBot) {
  // Atomic claim: flip status in the same statement that selects, so a
  // concurrent tick can't return the same rows. `returning()` gives us
  // exactly the rows this process won.
  const claimed = await db
    .update(schema.polls)
    .set({ status: "closed" })
    .where(
      and(eq(schema.polls.status, "published"), lte(schema.polls.closesAt, new Date())),
    )
    .returning({
      id: schema.polls.id,
      channelId: schema.polls.channelId,
      messageId: schema.polls.messageId,
    });

  if (claimed.length === 0) return;

  logger.info("Closing due polls", { count: claimed.length });

  await mapWithConcurrency(claimed, REST_CONCURRENCY, async (poll) => {
    if (!poll.messageId) return;
    try {
      // Strip the vote select so a closed poll can't take new votes.
      await bot.helpers.editMessage(poll.channelId, poll.messageId, { components: [] });
    } catch (err) {
      // The message may have been deleted. The poll is already closed in
      // the database, which is what actually stops votes counting — the
      // edit is cosmetic, so failing it isn't worth retrying.
      logger.debug("Could not edit closed poll message", {
        pollId: poll.id,
        error: String(err),
      });
    }
  });
}

/**
 * Claims and executes due rows from `scheduled_jobs`.
 *
 * The claim is a single UPDATE ... RETURNING with `SKIP LOCKED`, which is
 * the standard Postgres queue pattern: concurrent workers each get a
 * disjoint set of rows without blocking on each other's locks.
 */
async function drainScheduledJobs(bot: AppealyBot) {
  // ISO strings, not Dates. db.execute() hands parameters to postgres.js
  // unconverted, and it rejects a Date — Postgres coerces the string to
  // timestamptz from the column type. Using the query builder instead would
  // convert them, but this claim needs FOR UPDATE SKIP LOCKED, which the
  // builder cannot express.
  const now = new Date().toISOString();
  const staleClaimCutoff = new Date(Date.now() - CLAIM_VISIBILITY_MS).toISOString();

  const claimed = await db.execute(sql`
    UPDATE ${schema.scheduledJobs}
    SET claimed_at = ${now}, claimed_by = ${WORKER_ID}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM ${schema.scheduledJobs}
      WHERE run_at <= ${now}
        AND attempts < ${MAX_ATTEMPTS}
        AND (claimed_at IS NULL OR claimed_at < ${staleClaimCutoff})
      ORDER BY run_at
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, guild_id AS "guildId", subject_id AS "subjectId", payload
  `);

  const jobs = claimed as unknown as Array<{
    id: string;
    kind: string;
    guildId: bigint;
    subjectId: bigint | null;
    payload: Record<string, unknown> | null;
  }>;

  if (jobs.length === 0) return;
  logger.info("Draining scheduled jobs", { count: jobs.length });

  const succeeded: string[] = [];

  await mapWithConcurrency(jobs, REST_CONCURRENCY, async (job) => {
    try {
      switch (job.kind) {
        case "kick_unverified":
          await runKickUnverified(bot, job.guildId, job.subjectId);
          break;
        case "purge_expired_history":
          await runHistoryPurge(job.guildId);
          break;
        default:
          logger.warn("Unknown scheduled job kind, discarding", { kind: job.kind, id: job.id });
      }
      succeeded.push(job.id);
    } catch (err) {
      await db
        .update(schema.scheduledJobs)
        .set({ claimedAt: null, claimedBy: null, lastError: String(err) })
        .where(eq(schema.scheduledJobs.id, job.id));
      logger.warn("Scheduled job failed, will retry", { id: job.id, kind: job.kind, error: String(err) });
    }
  });

  // One DELETE for the whole successful batch rather than one per job.
  if (succeeded.length > 0) {
    await db.delete(schema.scheduledJobs).where(inArray(schema.scheduledJobs.id, succeeded));
  }
}

/**
 * Creates the `purge_expired_history` jobs that nothing else ever created.
 *
 * `runHistoryPurge` below and its `case` in the dispatcher have both existed
 * since retention was added — but no code path anywhere inserted a job of
 * that kind, so the purge had never run once. `historyRetentionDays` is
 * metered and billed for on the pricing page, and SCALING.md and
 * apiRateLimit.ts both claimed it was enforced. Writing the function was not
 * the same as running it.
 *
 * Once a day rather than every tick: the purge is idempotent, but scanning
 * every guild every 30 seconds to delete nothing is pure load. The daily
 * guard is a Redis SET NX with a 24h TTL, which doubles as the cross-replica
 * lock — if Redis is unavailable, withRedis returns null and this is SKIPPED,
 * matching withLock's reasoning: a day's delay in deleting expired rows is
 * recoverable, and two replicas enqueueing a duplicate job per guild is
 * wasted work draining through the queue.
 */
const HISTORY_DAY_KEY = "appealy:sched:history-purge-day";

async function enqueueHistoryPurges() {
  const claimedToday = await withRedis(
    (r) => r.set(HISTORY_DAY_KEY, new Date().toISOString(), {
      ex: 24 * 60 * 60,
      mode: "NX",
    }),
    null,
  );
  if (!claimedToday) return;

  try {
    // Only guilds the bot is actually in. A departed guild's rows are the
    // removal lifecycle's business, not retention's.
    const guilds = await db.query.guilds.findMany({
      columns: { id: true },
      where: eq(schema.guilds.botPresent, true),
    });
    if (guilds.length === 0) return;

    // Chunked. Each row binds several parameters and Postgres caps a
    // statement at 65535 of them, so one insert covering a large fleet would
    // fail outright — and it would fail on the largest deployments only,
    // which is the worst place for a limit to first appear.
    const CHUNK = 1_000;
    for (let i = 0; i < guilds.length; i += CHUNK) {
      await db.insert(schema.scheduledJobs).values(
        guilds.slice(i, i + CHUNK).map((g) => ({
          kind: "purge_expired_history" as const,
          guildId: g.id,
          runAt: new Date(),
        })),
      );
    }

    logger.info("Enqueued daily history purges", { guilds: guilds.length });
  } catch (err) {
    // Release the day key. withLock swallows this throw into a warn line, so
    // without the release a single transient failure would mean no purge for
    // a full 24 hours — and then the same again tomorrow if it recurred at
    // the same point.
    await withRedis((r) => r.del(HISTORY_DAY_KEY), null);
    throw err;
  }
}

async function runKickUnverified(bot: AppealyBot, guildId: bigint, userId: bigint | null) {
  if (!userId) return;

  // The original in-memory version queried verification_attempts filtered
  // ONLY on userId, with no guildId — so a user who verified in any other
  // server counted as verified here and was never kicked. It also couldn't
  // use the (guildId, userId) index, since guildId is the leading column.
  // Both fixed by scoping the query properly.
  const attempt = await db.query.verificationAttempts.findFirst({
    where: and(
      eq(schema.verificationAttempts.guildId, guildId),
      eq(schema.verificationAttempts.userId, userId),
      eq(schema.verificationAttempts.verified, true),
    ),
  });
  if (attempt) return; // verified in time — nothing to do

  await bot.helpers.kickMember(guildId, userId, "Did not complete verification in time");
  logger.info("Kicked unverified member after timeout", {
    guildId: guildId.toString(),
    userId: userId.toString(),
  });
}

/**
 * Enforces `historyRetentionDays`, which the pricing model charges for but
 * which nothing in the original codebase enforced anywhere — see
 * SCALING.md. Without this, submission history grows without bound, the
 * paid retention tiers mean nothing, and the `submissions`/`answers`
 * tables become the largest thing in the database.
 */
async function runHistoryPurge(guildId: bigint) {
  const { resolveEffectiveCaps } = await import("../services/rateLimitService.ts");
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  if (!guild) return;

  const caps = resolveEffectiveCaps(guild);
  const cutoff = new Date(Date.now() - caps.historyRetentionDays * 24 * 60 * 60 * 1000);

  // Only reviewed submissions are purged. A pending submission is live
  // work sitting in someone's review queue; deleting it because it aged
  // out would silently drop an application the applicant is still waiting
  // on. Answers cascade from the submission delete.
  //
  // Selected first, then deleted by id, so the batch limit is enforceable —
  // DELETE has no LIMIT in Postgres.
  const doomed = await db
    .select({ id: schema.submissions.id })
    .from(schema.submissions)
    .where(
      and(
        eq(schema.submissions.guildId, guildId),
        lte(schema.submissions.createdAt, cutoff),
        or(
          eq(schema.submissions.status, "accepted"),
          eq(schema.submissions.status, "denied"),
          eq(schema.submissions.status, "withdrawn"),
        ),
      ),
    )
    .limit(HISTORY_PURGE_BATCH);

  if (doomed.length === 0) return;

  if (!HISTORY_PURGE_ENABLED) {
    // The dry run. Says the number out loud every day until someone decides.
    logger.warn("History purge disabled — would have deleted submissions", {
      guildId: guildId.toString(),
      wouldDelete: doomed.length,
      atLeast: doomed.length === HISTORY_PURGE_BATCH ? "batch full, more remain" : "exact",
      retentionDays: caps.historyRetentionDays,
      enableWith: "HISTORY_PURGE_ENABLED=true",
    });
    return;
  }

  const deleted = await db
    .delete(schema.submissions)
    .where(inArray(schema.submissions.id, doomed.map((d) => d.id)))
    .returning({ id: schema.submissions.id });

  if (deleted.length > 0) {
    logger.info("Purged expired submission history", {
      guildId: guildId.toString(),
      count: deleted.length,
      retentionDays: caps.historyRetentionDays,
    });
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. Keeps batch work
 * from monopolizing the REST queue that live interactions also use. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        await fn(item);
      } catch (err) {
        logger.error("Batch item failed", { error: String(err) });
      }
    }
  });
  await Promise.all(workers);
}
