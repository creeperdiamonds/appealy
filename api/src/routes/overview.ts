// api/src/routes/overview.ts
//
// Everything the dashboard's landing view needs, in ONE request.
//
// This endpoint exists because of how the rest of the API is shaped. The
// existing routes are a clean per-resource CRUD surface — forms, panels,
// tickets, giveaways, submissions, anti-raid, billing — which is right for
// editing but wrong for an operations view. Assembling "what is happening
// in this server right now" from those routes takes eight or nine parallel
// requests, and every one of them independently pays the guild permission
// check. That's the pattern that made `guildAccess` the API's bottleneck in
// the first place; adding a dashboard that fans out across nine endpoints
// on every page load would have walked straight back into it.
//
// So the read path for the overview is one authenticated request that runs
// its queries in parallel server-side, where they share a connection pool
// and a permission check, and returns a single payload.
//
// Mounted at /api/guilds/:guildId/overview

import { Router } from "express";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess } from "../middleware/guildAccess.ts";
import { resolveEffectiveCaps } from "../services/rateLimitService.ts";
import { withRedis } from "../lib/redis.ts";
import { RATE_LIMIT_PRESETS } from "../../../shared/schema/pricing.ts";

export const overviewRouter = Router({ mergeParams: true });

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL ?? "http://bot:9090";
const INTERNAL_SECRET = process.env.INTERNAL_RPC_SECRET ?? "";

overviewRouter.use(requireGuildAccess);

function dayBucket() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.floor((tomorrow - now.getTime()) / 1000);
}

/**
 * Reads the bot's live counters without consuming them.
 *
 * These live in Redis rather than Postgres because they're written by the
 * bot on every metered action — putting them in a table would mean a
 * durable write per submission, which is exactly the pattern being removed
 * from the bot's hot paths. The dashboard reads the same keys the bot
 * increments, so what's displayed is the number actually being enforced,
 * not a separate count that can drift from it.
 */
async function readDailyCounters(guildId: string) {
  const names = ["submissionsPerDay", "ticketsPerDay", "giveawayEntriesPerDay"] as const;
  const bucket = dayBucket();

  const values = await withRedis(
    (r) => r.mget(...names.map((n) => `appealy:ratelimit:${guildId}:${n}:${bucket}`)),
    names.map(() => null) as (string | null)[],
  );

  const used = {} as Record<(typeof names)[number], number>;
  names.forEach((n, i) => {
    used[n] = Number(values[i] ?? 0) || 0;
  });
  return used;
}

async function fetchBotHealth(): Promise<Record<string, unknown> | null> {
  try {
    const controller = new AbortController();
    // The bot holds the gateway connection; if it's saturated this request
    // will hang. A dashboard that hangs waiting on an unhealthy bot is
    // worse than one that says "bot unreachable" quickly — the whole point
    // of this panel is to tell you when the bot is in trouble.
    const timeout = setTimeout(() => controller.abort(), 2_000);
    const r = await fetch(`${BOT_INTERNAL_URL}/internal/health`, {
      headers: { "X-Internal-Secret": INTERNAL_SECRET },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

overviewRouter.get("/", async (req, res, next) => {
  try {
    const guildIdStr = req.params.guildId;
    const guildId = BigInt(guildIdStr);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      guild,
      dailyUsed,
      formCount,
      panelCount,
      pendingSubmissions,
      submissions24h,
      openTickets,
      runningGiveaways,
      lockdown,
      antiRaid,
      recentAudit,
      statusBreakdown,
      dailySeries,
      botHealth,
    ] = await Promise.all([
      db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) }),
      readDailyCounters(guildIdStr),
      db.select({ n: count() }).from(schema.forms).where(eq(schema.forms.guildId, guildId)),
      db.select({ n: count() }).from(schema.panels).where(eq(schema.panels.guildId, guildId)),
      db
        .select({ n: count() })
        .from(schema.submissions)
        .where(
          and(eq(schema.submissions.guildId, guildId), eq(schema.submissions.status, "pending")),
        ),
      db
        .select({ n: count() })
        .from(schema.submissions)
        .where(
          and(eq(schema.submissions.guildId, guildId), gte(schema.submissions.createdAt, since24h)),
        ),
      db
        .select({ n: count() })
        .from(schema.tickets)
        .where(and(eq(schema.tickets.guildId, guildId), eq(schema.tickets.status, "open"))),
      db
        .select({ n: count() })
        .from(schema.giveaways)
        .where(and(eq(schema.giveaways.guildId, guildId), eq(schema.giveaways.status, "running"))),
      db.query.raidLockdowns.findFirst({ where: eq(schema.raidLockdowns.guildId, guildId) }),
      db.query.antiRaidConfigs.findFirst({ where: eq(schema.antiRaidConfigs.guildId, guildId) }),
      db.query.dashboardAuditLogs.findMany({
        where: eq(schema.dashboardAuditLogs.guildId, guildId),
        orderBy: [desc(schema.dashboardAuditLogs.createdAt)],
        limit: 8,
      }),
      db
        .select({ status: schema.submissions.status, n: count() })
        .from(schema.submissions)
        .where(
          and(eq(schema.submissions.guildId, guildId), gte(schema.submissions.createdAt, since7d)),
        )
        .groupBy(schema.submissions.status),
      // Submissions per day for the last 14 days. Grouped in Postgres
      // rather than fetching rows and counting in JS — for a busy guild
      // that difference is thousands of rows crossing the wire to produce
      // fourteen numbers.
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${schema.submissions.createdAt}), 'YYYY-MM-DD')`,
          n: count(),
        })
        .from(schema.submissions)
        .where(
          and(
            eq(schema.submissions.guildId, guildId),
            gte(schema.submissions.createdAt, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)),
          ),
        )
        .groupBy(sql`date_trunc('day', ${schema.submissions.createdAt})`)
        .orderBy(sql`date_trunc('day', ${schema.submissions.createdAt})`),
      fetchBotHealth(),
    ]);

    const caps = guild ? resolveEffectiveCaps(guild) : RATE_LIMIT_PRESETS.free.caps;
    const lockdownActive = Boolean(lockdown && lockdown.expiresAt > new Date());

    res.json({
      guild: guild
        ? {
            id: guild.id.toString(),
            name: guild.name,
            iconHash: guild.iconHash,
            tier: guild.rateLimitTier,
            hostingMode: guild.hostingMode,
            timezone: guild.timezone,
          }
        : null,

      accessLevel: req.guildAccessLevel,
      isOwner: Boolean(req.isGuildOwner),

      // The capacity panel. Every metered cap with its live usage, so an
      // operator can see what's about to run out before it does.
      capacity: {
        caps,
        used: {
          ...dailyUsed,
          formsPerGuild: formCount[0]?.n ?? 0,
          panelsPerGuild: panelCount[0]?.n ?? 0,
        },
        resetsInSeconds: secondsUntilUtcMidnight(),
      },

      activity: {
        pendingSubmissions: pendingSubmissions[0]?.n ?? 0,
        submissions24h: submissions24h[0]?.n ?? 0,
        openTickets: openTickets[0]?.n ?? 0,
        runningGiveaways: runningGiveaways[0]?.n ?? 0,
        statusBreakdown7d: Object.fromEntries(statusBreakdown.map((r) => [r.status, r.n])),
        submissionsByDay: dailySeries.map((r) => ({ day: r.day, count: r.n })),
      },

      security: {
        antiRaidEnabled: Boolean(antiRaid?.enabled),
        antiRaidAction: antiRaid?.action ?? null,
        joinThreshold: antiRaid?.joinThreshold ?? null,
        windowSeconds: antiRaid?.windowSeconds ?? null,
        lockdown: lockdownActive
          ? {
              active: true,
              triggeredAt: lockdown!.triggeredAt,
              triggeredByJoinCount: lockdown!.triggeredByJoinCount,
              expiresAt: lockdown!.expiresAt,
            }
          : { active: false },
      },

      // null means the bot didn't answer within 2s. The dashboard renders
      // that as an explicit "can't reach the bot" state rather than as
      // zeroes, which would look like a healthy idle bot.
      bot: botHealth,

      recentActivity: recentAudit.map((entry) => ({
        id: entry.id,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        userId: entry.userId.toString(),
        createdAt: entry.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Paginated audit log. Separate from the overview's last-8 preview because
 * this one is browsed rather than glanced at, and shouldn't make the
 * landing view slower for the majority of visits that never open it. */
overviewRouter.get("/audit", async (req, res, next) => {
  try {
    const guildId = BigInt(req.params.guildId);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [entries, total] = await Promise.all([
      db.query.dashboardAuditLogs.findMany({
        where: eq(schema.dashboardAuditLogs.guildId, guildId),
        orderBy: [desc(schema.dashboardAuditLogs.createdAt)],
        limit,
        offset,
      }),
      db
        .select({ n: count() })
        .from(schema.dashboardAuditLogs)
        .where(eq(schema.dashboardAuditLogs.guildId, guildId)),
    ]);

    res.json({
      entries: entries.map((e) => ({
        id: e.id,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        userId: e.userId.toString(),
        changes: e.changes,
        createdAt: e.createdAt,
      })),
      total: total[0]?.n ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

/** Pending scheduled work — the durable replacement for the in-memory
 * timers. Surfaced so staff can see queued auto-kicks rather than
 * discovering them when they fire. */
overviewRouter.get("/scheduled-jobs", async (req, res, next) => {
  try {
    const guildId = BigInt(req.params.guildId);
    const jobs = await db.query.scheduledJobs.findMany({
      where: eq(schema.scheduledJobs.guildId, guildId),
      orderBy: [schema.scheduledJobs.runAt],
      limit: 100,
    });

    res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        subjectId: j.subjectId?.toString() ?? null,
        runAt: j.runAt,
        attempts: j.attempts,
        lastError: j.lastError,
        claimed: Boolean(j.claimedAt),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Cancels a queued job. The in-memory `setTimeout` version had no way to
 * do this at all — once a kick was scheduled, the only way to stop it was
 * to restart the bot, which cancelled every other pending kick too. */
overviewRouter.delete("/scheduled-jobs/:jobId", async (req, res, next) => {
  try {
    const guildId = BigInt(req.params.guildId);
    const deleted = await db
      .delete(schema.scheduledJobs)
      .where(
        and(
          eq(schema.scheduledJobs.id, req.params.jobId),
          eq(schema.scheduledJobs.guildId, guildId), // scope to guild: never let one guild cancel another's jobs
        ),
      )
      .returning({ id: schema.scheduledJobs.id });

    if (deleted.length === 0) return res.status(404).json({ error: "job_not_found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
