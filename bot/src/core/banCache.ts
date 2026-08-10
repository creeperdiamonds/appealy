// bot/src/core/banCache.ts
//
// Ban lookups on the interaction hot path.
//
// Why this is NOT built like guildConfigCache
// -------------------------------------------
// guildConfigCache is a three-tier L1/L2/L3 cache because guild config is
// unbounded — one bundle per guild, and you cannot hold every guild's config
// in memory forever. Bans are the opposite shape: a few thousand rows total,
// across the whole platform, growing slowly. So there is no cache here at
// all. Every process holds the ENTIRE active ban set in a Map, loaded once
// at boot, and a lookup is a hash hit with no I/O and no TTL.
//
// This matters because of where the check runs. It runs before dispatch on
// every interaction, which is the same event loop that guildConfigCache was
// written to protect. Adding a Redis round trip there — ~0.5ms — would put
// back a slice of exactly the backpressure that cache removed, in exchange
// for consulting data that changes a handful of times a day.
//
// Memory cost: ~200 bytes per ban. Ten thousand bans is 2MB. Not a concern.
//
// Invalidation
// ------------
// Same pattern and the same reasoning as guildConfigCache: the API publishes
// on write and every replica applies the delta in one hop. The difference is
// that there is no TTL underneath to bound the worst case, so a dropped
// pub/sub message would leave a replica permanently stale. Hence the periodic
// full reload — infrequent enough to be free (one query every five minutes),
// and it also cleans up bans that have simply expired.
//
// Failure mode: FAIL OPEN
// -----------------------
// If Postgres is unreachable at boot, this starts empty and `isBanned`
// returns null for everyone. That is the correct direction to fail. A ban
// system that fails closed on a database blip locks every user out of the
// product to avoid letting a handful of banned ones in. The alert fires and
// staff can act; the alternative is a self-inflicted outage.

import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { getRedis } from "./redis.ts";
import { logger } from "../utils/logger.ts";
import { toPublicBan, type PublicBan } from "../../../shared/schema/bans.ts";

const BAN_CHANNEL = "appealy:bans:changed";
const FULL_RELOAD_MS = 300_000;

const userBans = new Map<string, PublicBan>();
const guildBans = new Map<string, PublicBan>();
let loaded = false;

async function reload(): Promise<void> {
  const rows = await db
    .select()
    .from(schema.bans)
    .where(
      and(
        isNull(schema.bans.revokedAt),
        or(isNull(schema.bans.expiresAt), gt(schema.bans.expiresAt, new Date())),
      ),
    );

  // Build into fresh maps and swap, so a concurrent lookup never sees a
  // half-populated set and briefly lets a banned account through.
  const nextUsers = new Map<string, PublicBan>();
  const nextGuilds = new Map<string, PublicBan>();
  for (const row of rows) {
    const ban = toPublicBan(row);
    (ban.subject === "user" ? nextUsers : nextGuilds).set(ban.subjectId, ban);
  }

  userBans.clear();
  guildBans.clear();
  for (const [k, v] of nextUsers) userBans.set(k, v);
  for (const [k, v] of nextGuilds) guildBans.set(k, v);

  loaded = true;
  logger.info("Ban set loaded", { users: userBans.size, guilds: guildBans.size });
}

export async function startBanCache(): Promise<void> {
  try {
    await reload();
  } catch (err) {
    logger.error("Ban set failed to load; failing open until next reload", { err });
  }

  setInterval(() => {
    reload().catch((err) => logger.error("Ban set reload failed", { err }));
  }, FULL_RELOAD_MS);

  // Own connection: a Redis subscriber cannot serve ordinary commands, same
  // constraint documented in guildConfigCache.
  try {
    const sub = (await getRedis()).duplicate();
    await sub.subscribe(BAN_CHANNEL);
    sub.on("message", (_channel, raw) => {
      try {
        const msg = JSON.parse(raw) as { op: "add" | "remove"; ban: PublicBan };
        const map = msg.ban.subject === "user" ? userBans : guildBans;
        if (msg.op === "add") map.set(msg.ban.subjectId, msg.ban);
        else map.delete(msg.ban.subjectId);
      } catch (err) {
        logger.warn("Malformed ban invalidation message", { err });
      }
    });
    logger.info("Subscribed to ban changes", { channel: BAN_CHANNEL });
  } catch (err) {
    logger.error("Ban subscriber failed to start; falling back to periodic reload", { err });
  }
}

/**
 * Zero-I/O ban check. Returns the ban that applies, user ban taking priority
 * over guild ban, or null.
 *
 * Priority matters for the message the subject sees: someone personally
 * banned who happens to also be in a banned server should be told about
 * their own ban, because that is the one they can do something about.
 */
export function isBanned(userId: bigint, guildId?: bigint): PublicBan | null {
  if (!loaded) return null; // fail open, see header
  return (
    userBans.get(userId.toString()) ??
    (guildId ? guildBans.get(guildId.toString()) ?? null : null)
  );
}

export function banCacheStats() {
  return { loaded, users: userBans.size, guilds: guildBans.size };
}

/** Called by the API after any ban write. Fire-and-forget by design. */
export const BAN_CHANNEL_NAME = BAN_CHANNEL;
