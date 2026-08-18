// bot/src/core/guildLookup.ts
//
// Replaces `bot.cache.guilds`, which Discordeno no longer provides.
//
// The call sites that used it were already written defensively — every one
// was `bot.cache?.guilds?.get(id)` with a fallback — because a cache miss was
// always possible. Now every read is a miss, so the fallback path is the only
// path, and doing it raw would mean a REST call per interaction for things as
// small as "what is this server called".
//
// So: fetch once, remember briefly. A guild's name and role list change rarely
// and none of the callers need to see a rename the instant it happens; the
// worst case is a stale name in a DM for up to a minute. Failures are cached
// as `undefined` too, deliberately — a guild the bot was just removed from
// should not be retried on every event for the next minute.

import type { AppealyBot } from "./client.ts";

type FetchedGuild = Awaited<ReturnType<AppealyBot["helpers"]["getGuild"]>>;

const TTL_MS = 60_000;
// Bounded so a bot in many guilds cannot grow this without limit. Well above
// the number of distinct guilds one process handles between sweeps.
const MAX_ENTRIES = 10_000;

const cache = new Map<bigint, { at: number; guild: FetchedGuild | undefined }>();

function sweep(now: number) {
  for (const [id, entry] of cache) {
    if (now - entry.at > TTL_MS) cache.delete(id);
  }
}

/**
 * The guild, or undefined if it can't be fetched (gone, or Discord is having
 * a bad day). Callers are expected to have a fallback — they all already did.
 */
export async function getGuild(
  bot: AppealyBot,
  guildId: bigint,
): Promise<FetchedGuild | undefined> {
  const now = Date.now();
  const hit = cache.get(guildId);
  if (hit && now - hit.at <= TTL_MS) return hit.guild;

  let guild: FetchedGuild | undefined;
  try {
    guild = await bot.helpers.getGuild(guildId);
  } catch {
    guild = undefined;
  }

  if (cache.size >= MAX_ENTRIES) sweep(now);
  cache.set(guildId, { at: now, guild });
  return guild;
}

/** Drops a guild's entry — call when the bot leaves, so it isn't served stale. */
export function forgetGuild(guildId: bigint) {
  cache.delete(guildId);
}
