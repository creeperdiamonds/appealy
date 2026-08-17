// bot/src/core/sharding.ts
//
// Automatic shard count: one shard per GUILDS_PER_SHARD guilds.
//
// ---------------------------------------------------------------------------
// Why you cannot just "add a shard"
// ---------------------------------------------------------------------------
// Discord assigns guilds to shards with
//
//     shard_id = (guild_id >> 22) % total_shards
//
// `total_shards` is in the denominator, so changing it from 2 to 3 remaps
// EVERY guild, not just the new ones. There is no append. Growing the fleet
// means tearing down every connection and identifying a fresh set — that's
// what "resharding" is, and it's why this module decides the count at startup
// and then leaves it alone.
//
// ---------------------------------------------------------------------------
// Why the count is checked at boot, not applied live
// ---------------------------------------------------------------------------
// Live resharding — running both sets simultaneously and cutting over — is a
// real technique and Discordeno supports it, but it doubles your connection
// count and memory for the duration. On a Pi that's the difference between
// working and OOM.
//
// So: the count is decided at startup, and a watcher notices when the fleet
// has outgrown it and says so. Applying it is one `docker compose restart`,
// at a moment you choose, rather than automatically at 3am mid-event.
//
// ---------------------------------------------------------------------------
// The failure this is mostly written to prevent
// ---------------------------------------------------------------------------
// Every shard that connects spends one "session start". Discord grants a
// limited number per day (1000 by default) and refuses new sessions when
// they're gone — for up to 24 hours, with no override and no appeal.
//
// A 4-shard bot in a crash loop spends 4 per restart. Restarting every 30
// seconds burns the entire daily budget in about two hours, and then the bot
// cannot start at all until the window resets. That is a much worse outage
// than whatever caused the crash loop.
//
// Hence `assertSessionBudget`: if there aren't enough sessions left to start
// safely, refuse to start and say why, rather than spending the last of them.

import { logger } from "../utils/logger.ts";
import { env } from "./env.ts";

export interface GatewayInfo {
  /** Discord's own recommendation — roughly guilds / 1000. */
  recommendedShards: number;
  sessionStartLimit: {
    total: number;
    remaining: number;
    resetAfterMs: number;
    /** How many shards may identify concurrently. 1 for most bots. */
    maxConcurrency: number;
  };
}

export interface ShardPlan {
  totalShards: number;
  reason: string;
  /** Set when the count came from something other than the guild count. */
  warning?: string;
}

/** Ask Discord. Cheap, unauthenticated apart from the bot token, no cache. */
export async function fetchGatewayInfo(token: string): Promise<GatewayInfo> {
  const res = await fetch("https://discord.com/api/v10/gateway/bot", {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `GET /gateway/bot failed: ${res.status} ${res.statusText}. ` +
        (res.status === 401 ? "Check DISCORD_BOT_TOKEN." : "Discord may be having problems."),
    );
  }
  const body = await res.json();
  return {
    recommendedShards: body.shards,
    sessionStartLimit: {
      total: body.session_start_limit.total,
      remaining: body.session_start_limit.remaining,
      resetAfterMs: body.session_start_limit.reset_after,
      maxConcurrency: body.session_start_limit.max_concurrency,
    },
  };
}

/**
 * Decide the shard count. Pure, so it's testable without a network call.
 *
 * `guildCount` is what the bot is actually in; Discord's recommendation is
 * used as a floor because Discord knows things we don't (large-bot sharding
 * requirements above 150k guilds, for one).
 *
 * The important bias: DON'T over-shard. Every extra shard is another
 * WebSocket, another ~40-60MB of heap, another session start on every
 * restart, and another 5 seconds of startup. Below one full bucket of guilds
 * a single shard is not a compromise — it is strictly better than two. Bots
 * that shard "to be ready" pay for it daily and gain nothing.
 */
export function planShards(
  guildCount: number,
  recommended: number,
  guildsPerShard: number,
  maxShards: number,
): ShardPlan {
  const byGuilds = Math.max(1, Math.ceil(guildCount / guildsPerShard));

  // Discord's recommendation is a floor, not a suggestion. Above 150k guilds
  // it reflects mandatory large-bot sharding, and ignoring it means the
  // gateway refuses the connection.
  let total = Math.max(byGuilds, recommended, 1);
  let reason =
    total === byGuilds
      ? `${guildCount} guilds / ${guildsPerShard} per shard`
      : `Discord recommends ${recommended} (floor)`;
  let warning: string | undefined;

  if (total > maxShards) {
    // A ceiling exists so a misconfigured GUILDS_PER_SHARD can't try to open
    // 400 WebSockets on a Raspberry Pi. Hitting it is a real problem, not a
    // detail — say so loudly rather than silently running under-sharded.
    warning =
      `Wanted ${total} shards but MAX_SHARDS=${maxShards}. Running under-sharded: ` +
      `each shard will carry ~${Math.ceil(guildCount / maxShards)} guilds. ` +
      `Raise MAX_SHARDS, or move to a bigger machine.`;
    total = maxShards;
    reason = `capped at MAX_SHARDS=${maxShards}`;
  }

  return { totalShards: total, reason, warning };
}

/**
 * Refuse to start if the session budget can't take it.
 *
 * The reserve is deliberately generous. Being told "not enough sessions, wait
 * 4 hours" is annoying; discovering at 2am that a crash loop spent the last
 * of them and nothing can connect until tomorrow is an outage.
 */
export function assertSessionBudget(
  totalShards: number,
  limit: GatewayInfo["sessionStartLimit"],
): void {
  // Keep 10% of the daily allowance, or 10 sessions, whichever is larger —
  // enough for several genuine restarts after a bad deploy.
  const reserve = Math.max(10, Math.ceil(limit.total * 0.1));
  const usable = limit.remaining - reserve;

  if (totalShards > usable) {
    const hours = (limit.resetAfterMs / 3_600_000).toFixed(1);
    throw new Error(
      `Not enough Discord session starts left to spawn ${totalShards} shard(s). ` +
        `${limit.remaining}/${limit.total} remaining, ${reserve} held in reserve, resets in ${hours}h. ` +
        `This usually means something has been crash-looping — check the logs before restarting again. ` +
        `Starting now would spend the reserve and could lock the bot out entirely until the window resets.`,
    );
  }

  if (limit.remaining < limit.total * 0.25) {
    logger.warn("Discord session starts running low", {
      remaining: limit.remaining,
      total: limit.total,
      resetInHours: Number((limit.resetAfterMs / 3_600_000).toFixed(1)),
      hint: "Repeated restarts spend these. They are not per-shard, they are per-day.",
    });
  }
}

/** Decide and log the plan. Call before bot.start(). */
export async function resolveSharding(token: string, guildCountHint = 0): Promise<ShardPlan> {
  const info = await fetchGatewayInfo(token);

  // On a cold start we don't know the guild count yet, so Discord's
  // recommendation carries the decision. It's derived from the same number,
  // so this is accurate, not a fallback.
  const plan = planShards(
    guildCountHint,
    info.recommendedShards,
    env.GUILDS_PER_SHARD,
    env.MAX_SHARDS,
  );

  assertSessionBudget(plan.totalShards, info.sessionStartLimit);

  logger.info("Shard plan", {
    totalShards: plan.totalShards,
    reason: plan.reason,
    discordRecommends: info.recommendedShards,
    guildsPerShard: env.GUILDS_PER_SHARD,
    sessionStartsRemaining: `${info.sessionStartLimit.remaining}/${info.sessionStartLimit.total}`,
    maxConcurrency: info.sessionStartLimit.maxConcurrency,
  });

  if (plan.warning) logger.warn(plan.warning);

  if (plan.totalShards === 1) {
    logger.info(
      "Running on a single shard. That's correct below " +
        `${env.GUILDS_PER_SHARD} guilds — extra shards would cost memory and session starts for no benefit.`,
    );
  }

  return plan;
}

/**
 * Watches for the fleet outgrowing its shard count.
 *
 * Deliberately does NOT reshard on its own. A reshard drops every connection
 * and re-identifies, so doing it automatically means the bot goes quiet for
 * ~30 seconds at whatever moment a guild happens to join — plausibly during
 * the event that caused the join. Notify, and let a human pick the moment.
 *
 * The 20% hysteresis exists because a bot sitting exactly on the boundary
 * would otherwise log this on every check forever as guilds join and leave.
 */
export function startReshardWatcher(
  currentShards: number,
  getGuildCount: () => number,
  intervalMs = 3_600_000,
) {
  const check = () => {
    const guilds = getGuildCount();
    const wanted = Math.max(1, Math.ceil(guilds / env.GUILDS_PER_SHARD));

    if (wanted > currentShards && guilds > currentShards * env.GUILDS_PER_SHARD * 1.2) {
      logger.warn("Time to reshard", {
        guilds,
        currentShards,
        recommendedShards: Math.min(wanted, env.MAX_SHARDS),
        action: "Restart the bot when convenient — the new count is picked up at startup.",
        cost: `${Math.min(wanted, env.MAX_SHARDS)} session starts, ~30s offline.`,
      });
    }
  };

  const timer = setInterval(check, intervalMs);
  // Deno keeps the process alive for pending timers; this one shouldn't.
  if (typeof Deno !== "undefined") Deno.unrefTimer(timer);
  return () => clearInterval(timer);
}
