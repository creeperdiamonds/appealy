// bot/src/services/userResolve.ts
//
// Turns Discord user ids into a name and a face, for the dashboard.
//
// WHY THE BOT DOES THIS AND NOT THE API
//
// Resolving a user needs a bot token, and the API does not have one — nor
// should it. So the dashboard asks the API, the API asks the bot over the
// internal control server, and the bot asks Discord.
//
// WHY IT IS CACHED HARD
//
// Without a cache, opening one application's history hits Discord once per
// distinct actor, every time anyone looks. A guild with a handful of
// reviewers would re-fetch the same four people all day, and Discord rate
// limits per route — so the punishment for a popular dashboard would land on
// the bot's ability to answer interactions.
//
// An hour is deliberately long. A name that is an hour stale is a cosmetic
// problem; being rate limited is not.
//
// WHY NOTHING IS STORED IN POSTGRES
//
// Names and avatars are read here and thrown away. The alternative —
// snapshotting them onto each event row — would mean holding Discord profile
// data indefinitely, which is more than site/privacy.html says this service
// keeps. That was a deliberate choice; see the submission_events comment in
// shared/schema/schema.ts. The cost is that someone who has left renders as a
// raw id, and this is where that cost is paid.

import { iconBigintToHash } from "@discordeno/bot";

import type { AppealyBot } from "../core/client.ts";
import { withRedis } from "../core/redis.ts";
import { logger } from "../utils/logger.ts";

export interface ResolvedUser {
  id: string;
  username: string;
  /** Always a usable URL — Discord's default avatar when they have none. */
  avatarUrl: string;
}

/** Long, on purpose. See the note above about rate limits. */
const CACHE_SECONDS = 60 * 60;

/** Bounded so one request cannot fan out into hundreds of Discord calls. */
const MAX_IDS = 50;

function cacheKey(id: string) {
  return `appealy:user:${id}`;
}

/**
 * Discord's fallback avatar for an account with none set.
 *
 * The modern (post-discriminator) rule is (id >> 22) % 6. The old
 * discriminator-based one is wrong for every account created since 2023, and
 * produces a valid-looking URL for the wrong image rather than an error.
 */
function defaultAvatarUrl(id: bigint): string {
  return `https://cdn.discordapp.com/embed/avatars/${(id >> 22n) % 6n}.png`;
}

function avatarUrlFor(id: bigint, avatar: bigint | undefined | null): string {
  if (!avatar) return defaultAvatarUrl(id);
  const hash = iconBigintToHash(avatar);
  // .png rather than .webp: universally renderable, and the size cap keeps a
  // timeline of twenty avatars from pulling twenty full-size images.
  return `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=64`;
}

/**
 * Resolves ids to names and faces, cached.
 *
 * An id that cannot be resolved — deleted account, or Discord refusing — is
 * simply absent from the result rather than faked. The dashboard renders the
 * raw id in that case, which is honest about what is known.
 */
export async function resolveUsers(bot: AppealyBot, ids: string[]): Promise<ResolvedUser[]> {
  const unique = [...new Set(ids.filter(Boolean))].slice(0, MAX_IDS);
  if (unique.length === 0) return [];

  const out: ResolvedUser[] = [];
  const misses: string[] = [];

  // Cache first. withRedis falls back rather than throwing, so a Redis outage
  // degrades this to "ask Discord every time" instead of breaking the page.
  for (const id of unique) {
    const hit = await withRedis<string | null>((r) => r.get(cacheKey(id)), null);
    if (hit) {
      try {
        out.push(JSON.parse(hit) as ResolvedUser);
        continue;
      } catch {
        // Corrupt entry; treat as a miss.
      }
    }
    misses.push(id);
  }

  for (const id of misses) {
    try {
      const user = await bot.helpers.getUser(BigInt(id));
      const resolved: ResolvedUser = {
        id,
        username: user.username,
        avatarUrl: avatarUrlFor(BigInt(id), user.avatar),
      };
      out.push(resolved);
      await withRedis(
        (r) => r.set(cacheKey(id), JSON.stringify(resolved), { ex: CACHE_SECONDS }),
        null,
      );
    } catch (err) {
      // Left out of the result deliberately. A deleted account has no name,
      // and inventing one ("Unknown User") in the data would make the
      // dashboard unable to tell "we could not resolve this" from "this
      // person is literally called Unknown User".
      logger.debug?.("Could not resolve a user for the dashboard", { id, error: String(err) });
    }
  }

  return out;
}
