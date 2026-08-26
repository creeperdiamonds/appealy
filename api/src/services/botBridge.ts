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

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL ?? "http://bot:9090";
const INTERNAL_SECRET = process.env.INTERNAL_RPC_SECRET ?? "";

async function callBot(path: string, body: unknown) {
  const res = await fetch(`${BOT_INTERNAL_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Bot control server returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
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
  return callBot("/internal/cache/invalidate", { guildId });
}

/**
 * Same, for a ban add or removal — the counterpart to publishBanChange in
 * banGate.ts when there is no real Redis to publish over. See
 * bot/src/core/banCache.ts's applyBanChange, which this ultimately drives on
 * the bot side; it is the same function the Redis subscriber calls, so a
 * ban applies identically over either transport.
 */
export function requestBanChange(op: "add" | "remove", ban: PublicBan) {
  return callBot("/internal/cache/ban", { op, ban });
}
