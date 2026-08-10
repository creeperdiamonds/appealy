// api/src/middleware/banGate.ts
//
// The dashboard half of ban enforcement. The half that matters is
// bot/src/core/banGate.ts — this one exists so a banned person gets an
// explanation and a way out, not because it stops anything.
//
// Ordering
// --------
// Mount after requireSession and before guildAccess:
//
//   app.use(requireSession, banGate, ...)
//
// requireSession has to run first because a ban is keyed on a user id and we
// do not have one until the session resolves. guildAccess runs after because
// a guild-banned server should fail the ban check with a ban-shaped response,
// not a generic 403 that the client renders as "you don't have access".
//
// Why a 403 body rather than a redirect
// -------------------------------------
// A redirect to /banned means the SPA has to decide whether it is allowed to
// be on /banned, which is one bad guard away from a redirect loop on an
// account that cannot escape it. A typed 403 lets the client swap in the ban
// screen wherever it already is, with no routing involved.

import type { Request, Response, NextFunction } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { toPublicBan, type PublicBan } from "../../../shared/schema/bans.ts";
import { redis } from "../lib/redis.ts";

const BAN_CHANNEL = "appealy:bans:changed";
const CACHE_TTL = 30;

async function activeBan(subject: "user" | "guild", subjectId: bigint): Promise<PublicBan | null> {
  // Redis is fine here — this is the web tier, where a 0.5ms hop per request
  // is noise. The bot process is the one that cannot afford it.
  const key = `bans:lookup:${subject}:${subjectId}`;
  const cached = await redis.get(key).catch(() => null);
  if (cached) return cached === "\0" ? null : (JSON.parse(cached) as PublicBan);

  const row = await db.query.bans.findFirst({
    where: and(
      eq(schema.bans.subject, subject),
      eq(schema.bans.subjectId, subjectId),
      isNull(schema.bans.revokedAt),
    ),
  });

  const live = row && (!row.expiresAt || row.expiresAt > new Date()) ? row : null;
  if (!live) {
    await redis.set(key, "\0", "EX", CACHE_TTL).catch(() => {});
    return null;
  }

  const openAppeal = await db.query.banAppeals.findFirst({
    where: and(eq(schema.banAppeals.banId, live.id), eq(schema.banAppeals.status, "open")),
    columns: { createdAt: true },
  });

  const pub = toPublicBan(live, openAppeal);
  await redis.set(key, JSON.stringify(pub), "EX", CACHE_TTL).catch(() => {});
  return pub;
}

export async function banGate(req: Request, res: Response, next: NextFunction) {
  if (!req.userId) return next();

  const ban = await activeBan("user", req.userId).catch(() => null);
  if (!ban) return next();

  // The appeal endpoints are the one thing a banned account may still reach.
  // Without this exemption the ban screen renders and its form 403s.
  if (req.path.startsWith("/appeals")) return next();

  return res.status(403).json({ error: "banned", ban });
}

/**
 * Guild list decoration.
 *
 * Filtering banned guilds out of the list would be simpler and is wrong: a
 * server that vanishes from the dashboard reads as a bug, and the owner opens
 * a support ticket about the disappearance rather than reading the ban. Keep
 * it visible, mark it clearly, make it appealable.
 */
export async function decorateGuildBans<T extends { id: string }>(
  guilds: T[],
): Promise<(T & { banned: boolean; ban: PublicBan | null })[]> {
  const bans = await Promise.all(
    guilds.map((g) => activeBan("guild", BigInt(g.id)).catch(() => null)),
  );
  return guilds.map((g, i) => ({ ...g, banned: bans[i] !== null, ban: bans[i] }));
}

/** Call after every ban write so bot replicas converge in one hop. */
export async function publishBanChange(op: "add" | "remove", ban: PublicBan) {
  await redis.del(`bans:lookup:${ban.subject}:${ban.subjectId}`).catch(() => {});
  await redis.publish(BAN_CHANNEL, JSON.stringify({ op, ban })).catch(() => {});
}
