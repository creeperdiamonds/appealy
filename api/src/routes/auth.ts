// api/src/routes/auth.ts
//
// Discord OAuth2 for the dashboard. A signed httpOnly cookie holds only a
// session id; the Discord tokens are encrypted at rest in Postgres and
// never reach the browser. That design was right and is unchanged.
//
// WHAT CHANGED
// ------------
// The OAuth `state` nonce store was an in-process `Map`, with its own
// comment acknowledging "for multi-instance API deployments, back this with
// Redis instead". That's the right instinct, and the consequences are worth
// spelling out because two of the three are not obvious:
//
//   1. LOGIN BREAKS BEHIND A LOAD BALANCER. The README describes the API as
//      "stateless, horizontally scalable", and docker-compose is one
//      `--scale api=3` away from proving otherwise. `/discord/login` writes
//      the state to replica A's memory; Discord redirects the browser back
//      to whichever replica the balancer picks; if that's B, the state
//      isn't there and the user gets `invalid_state`. Login fails roughly
//      (N-1)/N of the time — and it fails randomly, which is much harder to
//      diagnose than failing consistently.
//
//   2. IT LEAKS. Entries are deleted on a successful callback and only
//      then. Every abandoned login — a user who clicks "Authorize" and
//      closes the tab, or every bot that hits the login URL — leaves a
//      permanent entry. Nothing sweeps expired ones; the TTL is only
//      checked on the lookup path, for entries that are being removed
//      anyway. The Map grows monotonically for the process's lifetime.
//
//   3. A RESTART INVALIDATES IN-FLIGHT LOGINS. Anyone mid-authorize during
//      a deploy gets `invalid_state`.
//
// Redis with a native TTL fixes all three: shared across replicas, expiry
// handled by Redis rather than by remembering to sweep, and it survives a
// restart.
//
// One behavior deliberately does NOT degrade: if Redis is unavailable,
// login is REFUSED rather than allowed through. The state nonce is CSRF
// protection for the OAuth callback. Skipping it when the cache is down
// would mean an availability blip silently disables a security control —
// exactly when an attacker would most like it disabled.

import { Router } from "express";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { exchangeCodeForToken, fetchDiscordUser } from "../services/discordOAuth.ts";
import { encrypt } from "../utils/crypto.ts";
import { requireSession } from "../middleware/auth.ts";
import { invalidateGuildAccessCache } from "../middleware/guildAccess.ts";
import { withRedis } from "../lib/redis.ts";

export const authRouter = Router();

const SCOPES = "identify guilds";
const STATE_TTL_SECONDS = 300;

function stateKey(state: string) {
  return `appealy:oauth:state:${state}`;
}

authRouter.get("/discord/login", async (_req, res) => {
  const state = crypto.randomBytes(32).toString("hex");

  const stored = await withRedis(
    (r) => r.set(stateKey(state), "1", "EX", STATE_TTL_SECONDS, "NX"),
    null,
  );

  if (!stored) {
    return res.status(503).json({
      error: "login_unavailable",
      detail: "Sign-in is temporarily unavailable. Please try again in a moment.",
    });
  }

  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

authRouter.get("/discord/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    return res.status(400).json({ error: "invalid_state" });
  }

  // Consume atomically. GETDEL means a replayed callback — the same state
  // submitted twice — finds nothing on the second attempt. The original's
  // separate has/get/delete sequence left a window where two concurrent
  // requests could both pass the check before either deleted the entry.
  const consumed = await withRedis<string | null>(
    (r) => (r as unknown as { getdel: (k: string) => Promise<string | null> }).getdel(stateKey(state)),
    null,
  );

  if (!consumed) {
    // Covers all of: never issued, already used, expired, and Redis down.
    // Deliberately one message — distinguishing them for the caller would
    // tell an attacker which states exist.
    return res.status(400).json({ error: "invalid_state" });
  }

  try {
    const token = await exchangeCodeForToken(
      code,
      env.DISCORD_CLIENT_ID,
      env.DISCORD_CLIENT_SECRET,
      env.DISCORD_REDIRECT_URI,
    );
    const discordUser = await fetchDiscordUser(token.access_token);

    const [session] = await db
      .insert(schema.sessions)
      .values({
        userId: BigInt(discordUser.id),
        accessTokenEnc: encrypt(token.access_token),
        refreshTokenEnc: encrypt(token.refresh_token),
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
      })
      .returning();

    res.cookie("appealy_session", session.id, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.redirect(`${env.FRONTEND_ORIGIN}/dashboard`);
  } catch (err) {
    res.status(500).json({ error: "oauth_failed", detail: String(err) });
  }
});

authRouter.post("/logout", requireSession, async (req, res) => {
  await Promise.all([
    db.delete(schema.sessions).where(eq(schema.sessions.id, req.sessionId!)),
    // Without this, the cached permission set outlives the session it was
    // derived from. Harmless today since the key is unguessable, but a
    // logged-out session should leave nothing behind.
    invalidateGuildAccessCache(req.sessionId!),
  ]);
  res.clearCookie("appealy_session");
  res.status(204).send();
});

authRouter.get("/me", requireSession, async (req, res) => {
  res.json({ userId: req.userId!.toString() });
});

/**
 * Guilds this user can open in the dashboard, for the guild switcher.
 *
 * The original had no such endpoint, so the frontend had no way to
 * discover which servers it could show — a gap that only becomes obvious
 * once you actually build the dashboard against this API.
 *
 * Returns both Discord-permission guilds and delegation-only ones, tagged
 * by how access was granted, so the UI can show a manager why their view
 * is narrower than an admin's instead of leaving them to guess.
 */
authRouter.get("/me/guilds", requireSession, async (req, res) => {
  const { fetchUserGuilds, filterManageableGuilds } = await import(
    "../services/discordOAuth.ts"
  );

  let discordGuilds: Awaited<ReturnType<typeof fetchUserGuilds>> = [];
  let discordReachable = true;
  try {
    discordGuilds = await fetchUserGuilds(req.discordAccessToken!);
  } catch {
    discordReachable = false;
  }

  const manageable = filterManageableGuilds(discordGuilds);
  const byId = new Map(
    manageable.map((g) => [
      g.id,
      { id: g.id, name: g.name, icon: g.icon, access: g.owner ? "owner" : "admin" },
    ]),
  );

  const delegations = await db.query.staffPermissions.findMany({
    where: eq(schema.staffPermissions.userId, req.userId!),
  });

  const delegatedGuildIds = [...new Set(delegations.map((d) => d.guildId.toString()))].filter(
    (id) => !byId.has(id),
  );

  if (delegatedGuildIds.length > 0) {
    const rows = await db.query.guilds.findMany();
    for (const row of rows) {
      const id = row.id.toString();
      if (delegatedGuildIds.includes(id)) {
        byId.set(id, { id, name: row.name, icon: row.iconHash, access: "manager" });
      }
    }
  }

  res.json({
    guilds: [...byId.values()],
    // Told plainly rather than silently returning a short list, so the UI
    // can say "some servers may be missing" instead of implying the user
    // has lost access to servers they own.
    discordReachable,
  });
});
