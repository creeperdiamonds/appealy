// bot/src/core/statusPublisher.ts
//
// Heartbeat for the public status page.
//
// The page is a Cloudflare Worker (the status-page branch), not part of this
// deployment, so it survives the outage it reports. The Worker checks the
// dashboard and the API from outside by itself. The two things it cannot see
// from outside are the Discord shards and the database, so this process tells
// it, every 30 seconds.
//
// Silence is the signal
// ---------------------
// Nothing here ever reports "the bot is down" — a dead process can't. The
// Worker treats a heartbeat older than 90s as the bot being down, which is
// also exactly what a crash, a failed deploy or a Google Cloud outage looks
// like from outside. Don't add a "shutting down" message on top of this.
//
// What is deliberately NOT sent
// -----------------------------
// Per shard, an id and up/degraded/down. No latency figures, host ids, worker
// ids or guild counts. Published together those are a map of the
// infrastructure and a way to tell which shard is weakest — which is the
// shard to aim at. The internal console has them.
//
// One process, all shards
// -----------------------
// The Worker keeps a single latest heartbeat. That is right for today's
// deployment (maxScale 1, every shard in this process). If shards are ever
// split across processes, each would overwrite the others' report, and this
// needs a per-process key first.

import { sql } from "drizzle-orm";
import type { AppealyBot } from "./client.ts";
import { db } from "../db/client.ts";
import { logger } from "../utils/logger.ts";
import { classifyShard, type Heartbeat } from "./statusShape.ts";

const INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DATABASE_TIMEOUT_MS = 5_000;

let started = false;

function collectShards(bot: AppealyBot): Pick<Heartbeat, "totalShards" | "shards"> {
  // Read defensively, as controlServer.ts does: Discordeno's gateway
  // internals have shifted between releases, and a heartbeat that throws is a
  // heartbeat that stops — which the page would report as an outage.
  const gateway = (bot as unknown as {
    gateway?: {
      totalShards?: number;
      shards?: Map<number, { id: number; state?: number; heart?: { rtt?: number } }>;
    };
  }).gateway;

  const shards = gateway?.shards ? [...gateway.shards.values()] : [];
  return {
    totalShards: Math.max(gateway?.totalShards ?? 0, shards.length, 1),
    shards: shards.map((s) => ({ id: s.id, state: classifyShard(s) })).sort((a, b) => a.id - b.id),
  };
}

async function checkDatabase(): Promise<Heartbeat["database"]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DATABASE_TIMEOUT_MS);
      }),
    ]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opt-in. Both STATUS_HEARTBEAT_URL and STATUS_HEARTBEAT_SECRET must be set;
 * without them (local development, self-hosting) this does nothing and logs
 * nothing.
 */
export function startStatusPublisher(bot: AppealyBot): void {
  const url = Deno.env.get("STATUS_HEARTBEAT_URL");
  const secret = Deno.env.get("STATUS_HEARTBEAT_SECRET");
  if (!url || !secret) return;

  // onReady runs this for shard 0, and shard 0 sends READY again on every
  // fresh session. Without this, each reconnect would add another interval.
  if (started) return;
  started = true;

  // Logged on the transition only. A Worker outage would otherwise write the
  // same warning every 30 seconds and bury the ones that matter.
  let failing = false;

  const beat = async () => {
    const heartbeat: Heartbeat = {
      sentAt: new Date().toISOString(),
      ...collectShards(bot),
      database: await checkDatabase(),
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify(heartbeat),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      if (failing) {
        failing = false;
        logger.info("Status heartbeat recovered", {});
      }
    } catch (err) {
      if (!failing) {
        failing = true;
        logger.warn("Status heartbeat failed", { error: String(err) });
      }
    }
  };

  void beat();
  setInterval(() => void beat(), INTERVAL_MS);
  logger.info("Status heartbeat started", { intervalMs: INTERVAL_MS });
}

/**
 * Which shard a guild lives on.
 *
 *   (guild_id >> 22) % total_shards
 *
 * Discord's own formula. The status page computes it client-side from a
 * pasted server id, which keeps the lookup off every server entirely.
 */
export function shardForGuild(guildId: bigint, totalShards: number): number {
  return Number((guildId >> 22n) % BigInt(totalShards));
}
