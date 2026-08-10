// bot/src/events/guildCreate.ts
//
// Fires when the bot joins a guild, AND once per existing guild on every
// gateway reconnect. That second case is the one that matters: at N guilds a
// reconnect means N of these, back to back.
//
// Why this batches
// ----------------
// This used to do one `INSERT ... ON CONFLICT DO UPDATE` per guild. Against a
// pool of `max: 10` (see db/client.ts) that's N round trips competing for ten
// connections, during the exact window the bot is also handling the rest of
// the READY burst — and it starves every other query in the process while it
// runs.
//
// So during the burst, guilds are buffered and flushed as multi-row upserts.
// N queries becomes ceil(N / BATCH_SIZE).
//
// The flush is time- AND size-triggered, because neither alone is right: size
// alone means a bot in 40 guilds never flushes, and time alone means a bot in
// 40,000 guilds builds a huge array before its first write.
//
// A genuine new join (the bot being invited) is a single event with nothing
// following it, so the time trigger catches it — 250ms of delay before the
// dashboard shows a freshly-invited server is imperceptible.

import { sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { logger } from "../utils/logger.ts";
import { trackGuildCreate } from "../core/startupProfile.ts";
import type { Guild } from "@discordeno/bot";

const BATCH_SIZE = 500;
const FLUSH_AFTER_MS = 250;

type PendingGuild = {
  id: bigint;
  name: string;
  iconHash: string | null;
  ownerId: bigint;
};

let buffer: PendingGuild[] = [];
let flushTimer: number | null = null;
let inFlight: Promise<void> = Promise.resolve();

async function flush(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;

  const batch = buffer;
  buffer = [];

  // Chain rather than run concurrently. Two overlapping upserts touching the
  // same rows can deadlock, and there's no benefit to parallelism here when
  // the point is to stop monopolizing the pool.
  inFlight = inFlight.then(async () => {
    try {
      await db
        .insert(schema.guilds)
        .values(batch.map((g) => ({
          id: g.id,
          name: g.name,
          iconHash: g.iconHash,
          ownerId: g.ownerId,
        })))
        .onConflictDoUpdate({
          target: schema.guilds.id,
          set: {
            name: sql`excluded.name`,
            iconHash: sql`excluded.icon_hash`,
            ownerId: sql`excluded.owner_id`,
            updatedAt: new Date(),
          },
        });

      // One line per batch, not per guild. The old per-guild log meant N log
      // lines on every reconnect, which is its own measurable cost at scale
      // and drowns everything else in the startup window.
      logger.info("Guilds upserted", { count: batch.length });
    } catch (err) {
      // Re-queue nothing: a failed batch means those guilds keep whatever row
      // they already had, and the next reconnect will refresh them. Retrying
      // here risks compounding the pool pressure that caused the failure.
      logger.error("Failed to upsert guild batch", { count: batch.length, error: String(err) });
    }
  });

  return inFlight;
}

export async function onGuildCreate(guild: Guild, shardId = 0) {
  await trackGuildCreate(shardId, guild.id, async () => {
    buffer.push({
      id: guild.id,
      name: guild.name,
      iconHash: guild.icon ?? null,
      ownerId: guild.ownerId,
    });

    if (buffer.length >= BATCH_SIZE) {
      await flush();
      return;
    }
    if (flushTimer === null) {
      flushTimer = setTimeout(() => void flush(), FLUSH_AFTER_MS);
    }
  });
}

/** Flush on shutdown so a restart mid-burst doesn't drop buffered guilds. */
export async function flushGuildBuffer(): Promise<void> {
  await flush();
  await inFlight;
}
