// bot/src/core/statusPublisher.ts
//
// Public shard status.
//
// The one rule
// ------------
// A status page must survive the outage it exists to report. That rules out
// serving it from api/ (same Postgres pool that will be the thing that broke)
// and it rules out Redis-in-the-request-path (one more thing between the
// visitor and an answer). So the write path is: gateway writes a small JSON
// file to a shared volume every 10s, nginx serves it as a static asset, and
// nothing in the read path can fail independently of nginx itself.
//
// Staleness is the signal
// -----------------------
// Same trick as TTL-based liveness. If the gateway dies, the file stops being
// rewritten, `generatedAt` goes stale, and the page says so — which is a more
// honest outage report than anything the dead process could have published
// about itself. Don't build a heartbeat on top of this; the timestamp is it.
//
// What is deliberately NOT in this file
// -------------------------------------
// No host ids, no worker ids, no per-shard RTT, no guild counts. Those are
// operator data and they're in the internal console. Published together they
// are a map of your infrastructure and a way to tell which shard is weakest
// — which is the shard to aim at. A visitor needs one thing: is the shard my
// server is on up or not.

import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { AppealyBot } from "./client.ts";
import { logger } from "../utils/logger.ts";

const OUT_DIR = Deno.env.get("STATUS_OUT_DIR") ?? "/srv/status";
const INTERVAL_MS = 10_000;

type PublicShardState = "up" | "degraded" | "down";

interface StatusSnapshot {
  generatedAt: string;
  totalShards: number;
  shards: { id: number; state: PublicShardState; since: string }[];
  summary: { up: number; degraded: number; down: number };
}

/** Remembered so `since` reports when the state last CHANGED, not when we
 *  last looked. "Down for 3 minutes" and "down since Tuesday" are different
 *  messages and only one of them is worth waiting through. */
const changedAt = new Map<number, { state: PublicShardState; at: string }>();

function classify(shard: { connected?: boolean; rtt?: number }): PublicShardState {
  if (!shard.connected) return "down";
  if ((shard.rtt ?? 0) > 500) return "degraded";
  return "up";
}

async function publish(bot: AppealyBot): Promise<void> {
  const now = new Date().toISOString();
  const shards: StatusSnapshot["shards"] = [];
  const summary = { up: 0, degraded: 0, down: 0 };

  // ⚠️ Adjust to however your gateway exposes shard state. The shape this
  // needs is only { id, connected, rtt } — everything else stays internal.
  for (const shard of bot.gateway.shards.values()) {
    const state = classify(shard as never);
    const prev = changedAt.get(shard.id);
    if (!prev || prev.state !== state) changedAt.set(shard.id, { state, at: now });

    shards.push({ id: shard.id, state, since: changedAt.get(shard.id)!.at });
    summary[state]++;
  }

  const snapshot: StatusSnapshot = {
    generatedAt: now,
    totalShards: shards.length,
    shards: shards.sort((a, b) => a.id - b.id),
    summary,
  };

  // Write-then-rename. A visitor loading mid-write would otherwise get a
  // truncated file and a JSON parse error, which the page would render as an
  // outage it invented itself. rename() is atomic on the same filesystem.
  const tmp = join(OUT_DIR, ".status.json.tmp");
  await writeFile(tmp, JSON.stringify(snapshot));
  await rename(tmp, join(OUT_DIR, "status.json"));
}

export function startStatusPublisher(bot: AppealyBot): void {
  let timer: number | undefined;

  const tick = () =>
    publish(bot).catch((err) => {
      // A permission or missing-directory failure will not fix itself on the
      // next tick. Outside a container OUT_DIR is /srv/status, which does not
      // exist, and the bot runs without --allow-write regardless — so this
      // used to log a warning every ten seconds forever, which buries the
      // warnings that do mean something.
      const fatal =
        err instanceof Deno.errors.NotCapable || err instanceof Deno.errors.NotFound;

      if (fatal) {
        if (timer !== undefined) clearInterval(timer);
        logger.warn(
          "Status publishing disabled: cannot write to the output directory. " +
            "Set STATUS_OUT_DIR to a writable path and grant --allow-write to enable it.",
          { dir: OUT_DIR, error: err.name },
        );
        return;
      }

      logger.warn("Status publish failed", { error: String(err) });
    });

  tick();
  timer = setInterval(tick, INTERVAL_MS) as unknown as number;
  logger.info("Status publisher started", { dir: OUT_DIR, intervalMs: INTERVAL_MS });
}

/**
 * Which shard a guild lives on.
 *
 *   (guild_id >> 22) % total_shards
 *
 * Discord's own formula. Exported because the status page computes it
 * client-side from a pasted server id — that keeps the lookup off your
 * servers entirely, so it works under load and logs nothing about who asked
 * about which server.
 *
 * Resharding changes the answer for every guild. If you ever reshard, the
 * page must not be cached past that point — see the Cache-Control note in
 * status/README.md.
 */
export function shardForGuild(guildId: bigint, totalShards: number): number {
  return Number((guildId >> 22n) % BigInt(totalShards));
}
