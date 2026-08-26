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

async function publish(bot: AppealyBot, outDir: string): Promise<void> {
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
  const tmp = join(outDir, ".status.json.tmp");
  await writeFile(tmp, JSON.stringify(snapshot));
  await rename(tmp, join(outDir, "status.json"));
}

function isUnrecoverable(err: unknown): boolean {
  // A permission or missing-directory failure will not fix itself on the
  // next tick, so it is treated as fatal to the publisher (not to the bot):
  // stop retrying rather than log the same warning every ten seconds
  // forever, which buries the warnings that do mean something.
  return err instanceof Deno.errors.NotCapable || err instanceof Deno.errors.NotFound;
}

export async function startStatusPublisher(bot: AppealyBot): Promise<void> {
  // Opt-in, not default-on. There is currently no path from this container's
  // filesystem to anything nginx can serve — deploy/service.yaml declares no
  // shared volume between the `bot` and `web` containers (Cloud Run sidecars
  // do not share a filesystem unless one is explicitly mounted), so a file
  // written here today is unreachable by any reader. The intended wiring
  // (bot and web sharing a `status` volume) is documented in
  // status/README.md, but it is unwired everywhere, not just here:
  // docker-compose.yml has no `status` volume and no STATUS_OUT_DIR either,
  // so this is design documentation for a feature that has never actually
  // been connected, in any deployment target.
  //
  // Defaulting OUT_DIR to /srv/status and starting unconditionally — the
  // previous behaviour — meant every production boot logged "started"
  // immediately followed by "disabled": an announcement and its own
  // contradiction, back to back, on every single boot since the first
  // deploy (see task-11-brief.md). Requiring an explicit STATUS_OUT_DIR
  // means the common case (unset, no shared volume) logs nothing at all,
  // and the publisher only ever announces itself when it might actually
  // work. Do not reintroduce a default path here — set STATUS_OUT_DIR
  // explicitly once a shared volume exists for this deployment target.
  const outDir = Deno.env.get("STATUS_OUT_DIR");
  if (outDir === undefined) return;

  let timer: number | undefined;
  let disabled = false;

  const attempt = async () => {
    try {
      await publish(bot, outDir);
    } catch (err) {
      if (isUnrecoverable(err)) {
        disabled = true;
        if (timer !== undefined) clearInterval(timer);
        logger.warn(
          "Status publishing disabled: cannot write to the output directory. " +
            "Set STATUS_OUT_DIR to a writable path and grant --allow-write to enable it.",
          { dir: outDir, error: (err as Error).name },
        );
        return;
      }

      logger.warn("Status publish failed", { error: String(err) });
    }
  };

  // Awaited, and logged only after: this is the writability check. Logging
  // "started" before this resolved is the actual bug task 11 exists to fix
  // — it announced a service that, in the same breath, turned out to be
  // disabled. If STATUS_OUT_DIR is set but wrong, the warning above is the
  // only log line this function ever produces.
  await attempt();
  if (disabled) return;

  logger.info("Status publisher started", { dir: outDir, intervalMs: INTERVAL_MS });
  timer = setInterval(() => void attempt(), INTERVAL_MS) as unknown as number;
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
