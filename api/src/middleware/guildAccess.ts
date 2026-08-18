// api/src/middleware/guildAccess.ts
//
// Verifies the authenticated dashboard user may manage the guild in
// :guildId. Two paths to access, unchanged from the original:
//   1. Owner / Administrator / Manage Guild in Discord itself.
//   2. A `manager` staff_permissions delegation for this guild.
//
// WHAT CHANGED AND WHY IT MATTERED MOST
// -------------------------------------
// The original called `fetchUserGuilds(accessToken)` — a live HTTP request
// to `https://discord.com/api/v10/users/@me/guilds` — on EVERY request to
// EVERY `/api/guilds/:guildId/*` endpoint.
//
// That single line was the API's hard scaling ceiling, for three reasons:
//
//   a) LATENCY. Every dashboard request paid 100-300ms before its handler
//      ran. A page loading six resources paid it six times.
//
//   b) DISCORD'S RATE LIMIT. `/users/@me/guilds` is limited per user token.
//      A dashboard that fires several parallel requests on page load — which
//      is exactly what a dashboard does — will 429 against Discord. The
//      original swallowed that failure in a bare `catch {}` and fell
//      through to the delegation check, so a rate-limited admin was
//      silently demoted to "no access" and got a 403 on a server they own.
//      A confusing intermittent permissions bug, caused by a caching gap.
//
//   c) IT MADE THE FALLBACK LOAD-BEARING. Because the Discord call failed
//      often under load, the delegation query became the real code path
//      more often than intended.
//
// Now: the manageable-guild set is cached per session for 60 seconds. A
// user who is promoted or demoted in Discord sees it reflected within a
// minute, which is the right trade for permissions that are checked
// hundreds of times per session — and any change made through this
// dashboard invalidates the cache immediately, so the only path with a
// delay is one made in Discord's own UI.
//
// SECURITY NOTE: the cache is keyed on the SESSION id, never on the user
// id, and never on the guild id alone. Keying on user id would let a
// second, lower-privileged session for the same account read a cache entry
// populated by a more privileged one. Keying on guild id would share one
// user's permissions with every other user of that guild. Both are
// privilege-escalation shapes, so the key is deliberately the narrowest
// thing that's still useful.

import type { Request, Response, NextFunction } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { withRedis } from "../lib/redis.ts";
import { fetchUserGuilds, filterManageableGuilds } from "../services/discordOAuth.ts";

declare global {
  namespace Express {
    interface Request {
      guildAccessLevel?: "admin" | "manager";
      isGuildOwner?: boolean;
    }
  }
}

const PERMISSION_CACHE_SECONDS = 60;

interface CachedGuildAccess {
  manageable: string[];
  owned: string[];
}

function cacheKey(sessionId: string) {
  return `appealy:perms:${sessionId}`;
}

/**
 * Returns the session's manageable and owned guild IDs, from cache when
 * available.
 *
 * Unlike the original, a Discord API failure here is NOT swallowed — it's
 * signalled by returning null so the caller can distinguish "confirmed no
 * access" from "couldn't check". Those two must not produce the same
 * outcome: the first is a 403, the second is a 503. Conflating them is what
 * turned Discord rate limits into phantom permission errors.
 */
async function loadGuildAccess(
  sessionId: string,
  accessToken: string,
): Promise<CachedGuildAccess | null> {
  const cached = await withRedis<string | null>((r) => r.get(cacheKey(sessionId)), null);
  if (cached) {
    try {
      return JSON.parse(cached) as CachedGuildAccess;
    } catch {
      // Corrupt entry; fall through and refetch.
    }
  }

  try {
    const allGuilds = await fetchUserGuilds(accessToken);
    const access: CachedGuildAccess = {
      manageable: filterManageableGuilds(allGuilds).map((g) => g.id),
      owned: allGuilds.filter((g) => g.owner).map((g) => g.id),
    };
    await withRedis(
      (r) => r.set(cacheKey(sessionId), JSON.stringify(access), "EX", PERMISSION_CACHE_SECONDS),
      null,
    );
    return access;
  } catch {
    return null;
  }
}

/** Drops a session's cached permissions. Called on logout, and whenever
 * this dashboard changes something that affects access. */
export async function invalidateGuildAccessCache(sessionId: string): Promise<void> {
  await withRedis((r) => r.del(cacheKey(sessionId)), 0);
}

export async function requireGuildAccess(req: Request, res: Response, next: NextFunction) {
  const guildId = routeParams(req).guildId;
  if (!guildId) return res.status(400).json({ error: "missing_guild_id" });
  if (!req.userId || !req.discordAccessToken || !req.sessionId) {
    return res.status(401).json({ error: "not_authenticated" });
  }

  const access = await loadGuildAccess(req.sessionId, req.discordAccessToken);

  if (access?.manageable.includes(guildId)) {
    req.guildAccessLevel = "admin";
    req.isGuildOwner = access.owned.includes(guildId);
    return next();
  }

  // Delegation is checked whether or not Discord answered — a delegated
  // manager has no Discord-level permission on the guild, so their access
  // never depended on that call succeeding.
  const delegation = await db.query.staffPermissions.findFirst({
    where: and(
      eq(schema.staffPermissions.guildId, BigInt(guildId)),
      eq(schema.staffPermissions.userId, req.userId),
      isNull(schema.staffPermissions.formId), // guild-wide grant
      eq(schema.staffPermissions.canManageForm, true),
    ),
  });

  if (delegation) {
    req.guildAccessLevel = "manager";
    req.isGuildOwner = false;
    return next();
  }

  // Reached here with no Discord answer AND no delegation: we genuinely do
  // not know whether this user has access. Saying 403 would be a lie, and
  // it's the lie that made this look like a permissions bug rather than an
  // upstream outage. 503 with a retry hint is the honest response.
  if (access === null) {
    return res.status(503).json({
      error: "permission_check_unavailable",
      detail: "Couldn't reach Discord to confirm your permissions. Try again in a moment.",
      retryAfter: 5,
    });
  }

  return res.status(403).json({ error: "insufficient_permissions" });
}

/** Stricter variant for destructive/sensitive routes. */
export function requireAdminAccess(req: Request, res: Response, next: NextFunction) {
  if (req.guildAccessLevel !== "admin") {
    return res.status(403).json({ error: "admin_access_required" });
  }
  next();
}

/**
 * Restricts a route to the guild's actual owner — deliberately stricter
 * than requireAdminAccess. Used for full export/import, where an owner may
 * reasonably want the assurance that no delegated admin, however trusted
 * day to day, can pull or push a complete data dump without the owner's
 * own login.
 *
 * Ownership is read from the same cached set as everything else, but note
 * the asymmetry in how a cache miss is handled: `requireGuildAccess` falls
 * back to a delegation lookup, whereas this returns 503 and grants nothing.
 * An owner check that degrades into "probably fine" is not an owner check.
 */
export async function requireOwnerAccess(req: Request, res: Response, next: NextFunction) {
  const guildId = routeParams(req).guildId;
  if (!guildId || !req.discordAccessToken || !req.sessionId) {
    return res.status(401).json({ error: "not_authenticated" });
  }

  const access = await loadGuildAccess(req.sessionId, req.discordAccessToken);
  if (access === null) {
    return res.status(503).json({
      error: "permission_check_unavailable",
      detail: "Couldn't reach Discord to confirm server ownership. Try again in a moment.",
      retryAfter: 5,
    });
  }

  if (access.owned.includes(guildId)) {
    req.isGuildOwner = true;
    return next();
  }

  return res.status(403).json({
    error: "owner_access_required",
    detail: "This action can only be performed by the server owner.",
  });
}
