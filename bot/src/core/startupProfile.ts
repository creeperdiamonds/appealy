// bot/src/core/startupProfile.ts
//
// Where startup time actually goes.
//
// The question worth answering is not "how long did startup take" but "who
// was slow" — Discord delivering the GUILD_CREATE burst, or us processing it.
// Those need completely different fixes and wall-clock time alone can't tell
// them apart, so this tracks both:
//
//   wall    READY -> last GUILD_CREATE, elapsed real time
//   handler cumulative time inside onGuildCreate
//
// Reading the result:
//   handler ≈ wall   -> we are the bottleneck. Batch, cache, defer.
//   handler << wall  -> Discord's delivery rate. Nothing to fix; stop looking.
//
// Knowing when the burst is over
// ------------------------------
// Discord doesn't announce it. But the READY payload carries an array of
// unavailable guild stubs — that's the count of GUILD_CREATEs to expect, so
// we count down to zero.
//
// Some never arrive (a guild in an outage stays unavailable indefinitely), so
// there's also a quiet-period fallback: if no GUILD_CREATE lands for
// QUIET_MS, call it done and report the shortfall. Without that, a single
// unavailable guild means startup never reports at all — which is exactly the
// case where you most want the numbers.

import { logger } from "../utils/logger.ts";

const QUIET_MS = 10_000;

interface ShardProfile {
  shardId: number;
  readyAt: number;
  expected: number;
  received: number;
  firstGuildAt: number | null;
  lastGuildAt: number | null;
  handlerMs: number;
  slowest: { guildId: string; ms: number } | null;
  timer: number | null;
  reported: boolean;
}

const processStart = Date.now();
const shards = new Map<number, ShardProfile>();

export function markGatewayConnecting(): void {
  logger.info("Startup: gateway connecting", { sinceProcessStartMs: Date.now() - processStart });
}

/** Call from onReady. `expectedGuilds` is payload.guilds.length. */
export function markShardReady(shardId: number, expectedGuilds: number): void {
  shards.set(shardId, {
    shardId,
    readyAt: Date.now(),
    expected: expectedGuilds,
    received: 0,
    firstGuildAt: null,
    lastGuildAt: null,
    handlerMs: 0,
    slowest: null,
    timer: null,
    reported: false,
  });

  logger.info("Startup: shard READY", {
    shardId,
    sinceProcessStartMs: Date.now() - processStart,
    expectedGuilds,
  });

  if (expectedGuilds === 0) report(shardId, "no guilds");
  else armQuietTimer(shardId);
}

/**
 * Wrap the per-guild handler. Times it, counts it, and reports once the burst
 * looks finished.
 */
export async function trackGuildCreate<T>(
  shardId: number,
  guildId: bigint,
  work: () => Promise<T>,
): Promise<T> {
  const p = shards.get(shardId);
  const started = Date.now();
  try {
    return await work();
  } finally {
    if (p && !p.reported) {
      const ms = Date.now() - started;
      p.received++;
      p.handlerMs += ms;
      p.firstGuildAt ??= started;
      p.lastGuildAt = Date.now();
      if (!p.slowest || ms > p.slowest.ms) p.slowest = { guildId: guildId.toString(), ms };

      if (p.received >= p.expected) report(shardId, "all guilds received");
      else armQuietTimer(shardId);
    }
  }
}

function armQuietTimer(shardId: number): void {
  const p = shards.get(shardId);
  if (!p || p.reported) return;
  if (p.timer !== null) clearTimeout(p.timer);
  p.timer = setTimeout(() => report(shardId, "quiet period"), QUIET_MS);
}

function report(shardId: number, reason: string): void {
  const p = shards.get(shardId);
  if (!p || p.reported) return;
  p.reported = true;
  if (p.timer !== null) clearTimeout(p.timer);

  const wallMs = (p.lastGuildAt ?? p.readyAt) - p.readyAt;
  // The number that decides what to do next. High means our handlers are the
  // problem; low means we're waiting on Discord and there's nothing to fix.
  const handlerShare = wallMs > 0 ? Math.round((p.handlerMs / wallMs) * 100) : 0;

  logger.info("Startup: guild burst complete", {
    shardId,
    reason,
    guildsExpected: p.expected,
    guildsReceived: p.received,
    missing: p.expected - p.received,
    readyToLastGuildMs: wallMs,
    timeInOurHandlersMs: p.handlerMs,
    handlerSharePercent: handlerShare,
    avgHandlerMs: p.received > 0 ? Math.round(p.handlerMs / p.received) : 0,
    slowestGuild: p.slowest,
    totalSinceProcessStartMs: Date.now() - processStart,
  });

  if (handlerShare > 50) {
    logger.warn(
      "Startup: our own handlers dominated the guild burst — batching or deferring per-guild work will help",
      { shardId, handlerSharePercent: handlerShare },
    );
  }
}

/** For /ops and the control server. */
export function startupSnapshot() {
  return {
    processStart: new Date(processStart).toISOString(),
    shards: [...shards.values()].map((p) => ({
      shardId: p.shardId,
      expected: p.expected,
      received: p.received,
      readyToLastGuildMs: (p.lastGuildAt ?? p.readyAt) - p.readyAt,
      timeInOurHandlersMs: p.handlerMs,
      complete: p.reported,
    })),
  };
}
