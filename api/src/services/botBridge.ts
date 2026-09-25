// api/src/services/botBridge.ts
//
// The API process is stateless and horizontally scalable; the bot process
// holds the single live Discord gateway connection. Some dashboard actions
// (publishing a panel message, re-syncing an edited panel, force-publishing
// a poll) require that live connection, so the API calls a small internal
// control server the bot exposes (bot/src/core/controlServer.ts) rather
// than duplicating Discord REST logic here.
//
// This internal endpoint is NOT the public API — it must only be reachable
// on the private network between services (see docker-compose.yml network
// config) and is additionally protected by a shared secret header.

import type { PublicBan } from "../../../shared/schema/platformBans.ts";
import { logger } from "../utils/logger.ts";

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL ?? "http://bot:9090";
const INTERNAL_SECRET = process.env.INTERNAL_RPC_SECRET ?? "";

/**
 * How long to wait on the bot before giving up.
 *
 * Not arbitrary: a container that is DOWN rejects immediately with
 * ECONNREFUSED, but one that is RESTARTING has bound the port and simply
 * does not answer — that case does not reject at all, it hangs to undici's
 * ~300s default. Several of these calls are awaited before an HTTP response
 * is sent (publishBanChange, requestLockdownClear, and every publish/sync
 * caller), so an unbounded wait turns a committed write into a request the
 * admin watches time out. Ten seconds is far above what a handful of
 * Discord REST calls need and far below anything a user or Cloud Run will
 * sit through.
 */
const BOT_CALL_TIMEOUT_MS = 10_000;

/**
 * Shorter bound for the two fire-and-forget cache-invalidation calls below.
 *
 * Nothing reads their result — both callers `.catch(() => {})` the
 * rejection and move on — so there is no reason for either to hold a
 * request thread (invalidateGuildCache runs after the response already
 * flushed, but publishBanChange runs before it) for as long as a call whose
 * result actually matters.
 */
const BOT_CALL_TIMEOUT_MS_FAST = 2_000;

// AbortSignal.timeout has been available since Node 17.3; this repo targets
// Node >=24 (api/package.json engines), so no AbortController+setTimeout
// fallback is needed.
async function callBot(path: string, body: unknown, timeoutMs: number = BOT_CALL_TIMEOUT_MS) {
  const res = await fetch(`${BOT_INTERNAL_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // The bot answers a failed Discord call with {error, code, status, hint}.
    // Passing the whole JSON blob through as text put literal braces on a
    // user's screen; lifting the fields out keeps the cause and the fix and
    // drops the punctuation. A non-JSON body (a crash, a proxy page) still
    // falls back to the raw text, which is the only thing there to say.
    const raw = await res.text();
    let detail = raw;
    let hint: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { error?: string; hint?: string };
      if (parsed.error) detail = parsed.error;
      hint = parsed.hint;
    } catch {
      // Not JSON — keep the raw text.
    }
    throw Object.assign(new Error(hint ? `${detail} ${hint}` : detail), {
      botStatus: res.status,
      hint,
    });
  }
  return res.json();
}

/**
 * The 502 body for a bot call that failed, told apart by whose fault it was.
 *
 * "bot_unreachable" used to be reported for both cases. It is only true when
 * the bot never answered — a deploy, a crash, a timeout. When the bot answered
 * and Discord refused (a missing permission, a deleted channel), calling it
 * unreachable sends the reader to look at the wrong thing entirely, and it is
 * the case they can actually fix.
 *
 * callBot sets botStatus on the thrown error whenever the bot replied, which
 * is what separates the two here.
 */
export function botCallFailure(err: unknown): { error: string; detail: string } {
  const botStatus = (err as { botStatus?: number }).botStatus;
  const detail = err instanceof Error ? err.message : String(err);
  return { error: botStatus ? "discord_refused" : "bot_unreachable", detail };
}

/**
 * Clear an anti-raid lockdown through the bot.
 *
 * Goes through the bot rather than being done here because the lockdown's
 * "is it active" answer is cached in the bot's process, and the bot's own
 * clearLockdown() evicts that cache as well as writing the row. Doing only the
 * write here left the cache saying "still locked" for up to its TTL — during
 * which members joining were still kicked, after an admin had been told the
 * lockdown was cleared.
 */
export function requestLockdownClear(guildId: string, clearedBy: string) {
  return callBot("/internal/anti-raid/clear-lockdown", { guildId, clearedBy }) as Promise<{
    cleared: boolean;
  }>;
}

export function requestPanelPublish(panelId: string) {
  return callBot("/internal/panels/publish", { panelId });
}

export function requestPanelSync(panelId: string) {
  return callBot("/internal/panels/sync", { panelId });
}

export function requestPollPublish(pollId: string) {
  return callBot("/internal/polls/publish", { pollId });
}

export function requestTicketPanelPublish(configId: string) {
  return callBot("/internal/tickets/publish-panel", { configId });
}

export function requestGiveawayPublish(giveawayId: string) {
  return callBot("/internal/giveaways/publish", { giveawayId });
}

export function requestGiveawayEnd(giveawayId: string) {
  return callBot("/internal/giveaways/end", { giveawayId });
}

export function requestGiveawayReroll(giveawayId: string) {
  return callBot("/internal/giveaways/reroll", { giveawayId });
}

export function requestVerificationPublish(guildId: string) {
  return callBot("/internal/verification/publish", { guildId });
}

export function requestRoleMenuPublish(menuId: string) {
  return callBot("/internal/role-menus/publish", { menuId });
}

export function requestStickyMessagePublish(stickyId: string) {
  return callBot("/internal/sticky-messages/publish", { stickyId });
}

/**
 * Names and faces for a set of Discord user ids.
 *
 * The API has no bot token, so this goes through the bot. Results are cached
 * on the bot side for an hour — see bot/src/services/userResolve.ts for why
 * that is long rather than short.
 *
 * Failure is not fatal to the caller: an id that cannot be resolved is simply
 * absent from the result, and the dashboard shows the raw id. A history that
 * renders ids is far better than one that fails to load.
 */
export async function resolveUsers(
  ids: string[],
): Promise<{ id: string; username: string; avatarUrl: string }[]> {
  if (ids.length === 0) return [];
  try {
    const res = (await callBot("/internal/users/resolve", { ids })) as {
      users?: { id: string; username: string; avatarUrl: string }[];
    };
    return res.users ?? [];
  } catch (err) {
    logger.warn("Could not resolve usernames; the dashboard will show ids", {
      count: ids.length,
      error: String(err),
    });
    return [];
  }
}

/**
 * Tells the bot to drop its cached config for a guild.
 *
 * Used only when REDIS_URL is the in-memory substitute, where the pub/sub
 * path in cacheInvalidation.ts cannot cross processes — the API and bot each
 * hold their own copy of the shim, so a publish() from here reaches nothing.
 * The caller (invalidateGuildCache in cacheInvalidation.ts) is responsible
 * for the fire-and-forget contract; this function itself can still reject
 * (a non-2xx from callBot, or the bot being unreachable) and callers must
 * treat that as expected, not exceptional.
 */
export function requestCacheInvalidate(guildId: string) {
  return callBot("/internal/cache/invalidate", { guildId }, BOT_CALL_TIMEOUT_MS_FAST);
}

/**
 * Same, for a ban add or removal — the counterpart to publishBanChange in
 * banGate.ts when there is no real Redis to publish over. See
 * bot/src/core/banCache.ts's applyBanChange, which this ultimately drives on
 * the bot side; it is the same function the Redis subscriber calls, so a
 * ban applies identically over either transport.
 *
 * publishBanChange awaits this BEFORE its own HTTP response is sent (unlike
 * invalidateGuildCache, which fires from res.on("finish")), which is exactly
 * why the fast timeout matters here: a wedged bot must add at most ~2s to a
 * ban write, not leave the admin's request hanging until Cloud Run's own
 * timeout fires.
 */
export function requestBanChange(op: "add" | "remove", ban: PublicBan) {
  return callBot("/internal/cache/ban", { op, ban }, BOT_CALL_TIMEOUT_MS_FAST);
}
