// api/src/routes/auth.ts
//
// Discord OAuth2 for the dashboard. A signed httpOnly cookie holds only a
// session id; the Discord tokens are encrypted at rest in Postgres and
// never reach the browser. That design was right and is unchanged.
//
// TWO THINGS THAT DEPEND ON THIS BEING SERVED SAME-ORIGIN WITH THE CONSOLE
//
//   The session cookie below is SameSite=Lax, which is the right default and
//   is deliberately not relaxed to SameSite=None. Lax means the browser only
//   attaches it to cross-origin requests that are still same-SITE, so the
//   console must reach this router on its own origin. web/nginx.conf proxies
//   /auth and /api for exactly that reason, and DISCORD_REDIRECT_URI points
//   at the console's origin rather than the API's so that the callback
//   response carrying Set-Cookie is first-party. Getting this wrong is not a
//   visible error: login succeeds, and every request afterwards is anonymous.
//
//   Popup sign-in (mode=popup below) needs window.opener alive in the popup.
//   The console sends Cross-Origin-Opener-Policy: same-origin-allow-popups
//   for the same reason — see web/nginx.conf.
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
import { logger } from "../utils/logger.ts";

export const authRouter = Router();

const SCOPES = "identify guilds";

/**
 * Permissions the invite link asks for, named rather than pasted as a number.
 *
 * Every one is load-bearing somewhere: roles for accept/deny grants, channels
 * for ticket creation, ban/kick for appeal unbans and verification timeouts,
 * message management for sticky messages. An invite that omits one produces a
 * feature that silently does nothing, which is the failure mode this whole
 * screen exists to prevent.
 */
const INVITE_PERMISSIONS = [
  ["MANAGE_ROLES", 1n << 28n],
  ["MANAGE_CHANNELS", 1n << 4n],
  ["VIEW_CHANNEL", 1n << 10n],
  ["SEND_MESSAGES", 1n << 11n],
  ["MANAGE_MESSAGES", 1n << 13n],
  ["EMBED_LINKS", 1n << 14n],
  ["READ_MESSAGE_HISTORY", 1n << 16n],
  ["KICK_MEMBERS", 1n << 1n],
  ["BAN_MEMBERS", 1n << 2n],
] as const;

const INVITE_PERMISSION_BITS = INVITE_PERMISSIONS.reduce((acc, [, bit]) => acc | bit, 0n);

/**
 * Where to send someone to add the bot to a specific server.
 *
 * guild_id preselects it in Discord's own dialog, so the person is not asked
 * to pick from a list they just came from — and disable_guild_select stops them
 * landing on the wrong one.
 */
/**
 * A usable URL for a guild icon, or null.
 *
 * Discord sends an icon HASH, not a URL, and every consumer of this endpoint
 * was reading a field called iconUrl that nothing has ever produced — so every
 * guild icon in the console resolved to undefined and rendered as a broken
 * image. Built here rather than in the browser because the CDN path needs the
 * guild id as well as the hash, and this is the only place that reliably has
 * both.
 *
 * Animated icons are prefixed a_ and must be requested as .gif; asking for
 * .png returns a still frame, which is worse than the thing the server chose.
 */
function guildIconUrl(guildId: string, hash: string | null | undefined): string | null {
  if (!hash) return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.${ext}?size=64`;
}

/**
 * The invite link with no server preselected, for the marketing site.
 *
 * Exists as a redirect rather than a URL printed into the HTML because the
 * site is static and has no way to learn DISCORD_CLIENT_ID. The alternative
 * was a placeholder substituted at deploy — a build step for a folder of HTML,
 * and one more thing to get wrong per environment. A 302 costs nothing and is
 * always right for the deployment serving it.
 */
export function genericInviteUrl(): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", INVITE_PERMISSION_BITS.toString());
  return url.toString();
}

function inviteUrlFor(guildId: string): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("permissions", INVITE_PERMISSION_BITS.toString());
  url.searchParams.set("guild_id", guildId);
  url.searchParams.set("disable_guild_select", "true");
  return url.toString();
}
const STATE_TTL_SECONDS = 300;

function stateKey(state: string) {
  return `appealy:oauth:state:${state}`;
}

type LoginMode = "redirect" | "popup";

/**
 * The completed-sign-in page for popup mode.
 *
 * Carries no token and no session id — the session is already an httpOnly
 * cookie set on this very response, so the opener has everything it needs the
 * moment this document loads. All that crosses the postMessage boundary is
 * "it worked" or "it didn't", which is why this can be a fire-and-forget
 * message rather than a channel that needs securing in both directions.
 *
 * `targetOrigin` is FRONTEND_ORIGIN exactly, never "*" — a wildcard would
 * hand the message to whatever origin happened to open the popup.
 */
function authResultPage(origin: string, ok: boolean, error?: string): string {
  // JSON.stringify escaped for inline <script>: a literal </script> inside a
  // string would close the element early. None of these values are
  // user-controlled today, but the page should not depend on that staying true.
  const json = (v: unknown) =>
    JSON.stringify(v).replace(/</g, "\u003c").replace(/>/g, "\u003e");

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${ok ? "Signed in" : "Sign-in failed"}</title></head>
<body style="font:14px system-ui;padding:2rem;text-align:center">
<p>${ok ? "Signed in. You can close this window." : "Sign-in failed. You can close this window."}</p>
<script>
(function () {
  var payload = ${json({ type: "appealy:auth", ok, error: error ?? null })};
  try {
    // No opener means this was a redirect-mode login that failed, or a popup
    // the browser reopened as a tab. Either way the message has nowhere to go
    // and the text above is the whole response.
    if (window.opener) window.opener.postMessage(payload, ${json(origin)});
  } catch (e) {}
  // Only a script-opened window may close itself. When the "popup" was
  // actually a new tab this silently does nothing, which is why the message
  // above tells the user rather than assuming the window disappears.
  window.close();
})();
</script>
</body></html>`;
}

authRouter.get("/discord/login", async (req, res) => {
  const state = crypto.randomBytes(32).toString("hex");

  // The mode rides the state entry rather than the callback URL. Discord
  // requires redirect_uri to match the registered value character for
  // character, so it cannot carry a per-request query param — and a mode read
  // off the callback would be caller-controlled anyway. Stored here, it comes
  // back from the same atomic GETDEL that already proves the nonce is genuine.
  const mode: LoginMode = req.query.mode === "popup" ? "popup" : "redirect";

  const stored = await withRedis(
    (r) => r.set(stateKey(state), mode, "EX", STATE_TTL_SECONDS, "NX"),
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
    // Same reasoning as the consume failure below: this is a window a person
    // is looking at, not a fetch() response.
    return res.status(400).type("html").send(authResultPage(env.FRONTEND_ORIGIN, false, "invalid_state"));
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
    //
    // The mode lived in the entry that just failed to resolve, so this is the
    // one path that cannot know whether it was a popup. The page handles both:
    // it messages an opener if there is one and otherwise reads as a plain
    // error page, which beats returning JSON to a window a human is looking at.
    logger.warn("Discord OAuth callback rejected: state nonce not found", {
      hint: "Expired (over 5 minutes), already used, or issued by a different process.",
    });
    return res.status(400).type("html").send(authResultPage(env.FRONTEND_ORIGIN, false, "invalid_state"));
  }

  const mode: LoginMode = consumed === "popup" ? "popup" : "redirect";

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

    // sameSite "lax", not "none". Lax is the safer default and it is
    // sufficient here because the console reaches this router on its own
    // origin (web/nginx.conf proxies /auth and /api). "none" would paper over
    // a split-origin deployment and then fail anyway in Safari and Firefox,
    // which block third-party cookies outright — so the proxy is the fix and
    // this stays strict. No `domain` is set on purpose: the cookie is scoped
    // to whichever host served this response, which is the console.
    res.cookie("appealy_session", session.id, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    if (mode === "popup") {
      // The cookie above is already on this response; the opener only needs to
      // hear that it can retry whatever it was doing.
      return res.type("html").send(authResultPage(env.FRONTEND_ORIGIN, true));
    }

    res.redirect(`${env.FRONTEND_ORIGIN}/dashboard/`);
  } catch (err) {
    // Logged server-side as well as returned. Without this the only copy of
    // Discord's actual complaint — which names the reason, e.g. a redirect_uri
    // that doesn't match the registered one — was in a response body someone
    // had to think to read, and the server log said nothing at all.
    logger.error("Discord OAuth callback failed", { error: String(err) });

    // Deliberately no `detail` in popup mode: that string is an exception
    // message from the Discord exchange, and it ends up rendered in a window
    // rather than read by a developer.
    if (mode === "popup") {
      return res.status(500).type("html").send(authResultPage(env.FRONTEND_ORIGIN, false, "oauth_failed"));
    }
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
      {
        id: g.id,
        name: g.name,
        icon: g.icon,
        iconUrl: guildIconUrl(g.id, g.icon),
        access: g.owner ? "owner" : "admin",
        // Filled in below. Assumed absent until a row says otherwise, because
        // claiming the bot is present when it is not is the failure this is
        // here to stop.
        installed: false,
        inviteUrl: inviteUrlFor(g.id),
      },
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
        byId.set(id, {
          id,
          name: row.name,
          icon: row.iconHash,
          iconUrl: guildIconUrl(id, row.iconHash),
          access: "manager",
          installed: row.botPresent,
          inviteUrl: inviteUrlFor(id),
        });
      }
    }
  }

  // Which of these the bot is actually in.
  //
  // Discord tells us which servers the person can manage; it says nothing about
  // whether Appealy is in them. Without this the switcher listed all of them
  // identically and picking one the bot had never joined produced a console
  // that looked functional and failed on every request — the dashboard
  // asserting something untrue about the world.
  //
  // A row that exists but has botPresent false is a server that removed the
  // bot: its configuration is still there, waiting, and re-inviting restores
  // it. Both cases read as "not installed" here and differ only in what
  // happens after the invite.
  const known = await db.query.guilds.findMany({
    columns: { id: true, botPresent: true },
  });
  const presentIds = new Set(
    known.filter((row) => row.botPresent).map((row) => row.id.toString()),
  );
  for (const [id, guild] of byId) {
    guild.installed = presentIds.has(id);
  }

  res.json({
    guilds: [...byId.values()],
    // Told plainly rather than silently returning a short list, so the UI
    // can say "some servers may be missing" instead of implying the user
    // has lost access to servers they own.
    discordReachable,
  });
});
