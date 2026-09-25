// bot/src/core/presence.ts
//
// "Watching N servers", on the bot's Discord profile.
//
// WHY THE COUNT IS FILTERED
//
// guildDelete never deletes a row — it sets botPresent = false, so a server
// that removes the bot keeps every form, panel and submission it configured
// and gets them all back on re-invite. That makes COUNT(*) over guilds the
// wrong number: it includes every server that ever removed the bot, and it
// only ever climbs. The count here is filtered to botPresent = true, which is
// the number a person means when they ask how many servers the bot is in.
//
// WHY THE DATABASE RATHER THAN THE GATEWAY CACHE
//
// The bot may run more than one shard, and each shard sees only its own
// guilds. A per-process tally would show a fraction of the truth on every
// shard but one, and the presence is global. The guilds table is the only
// place that knows the whole fleet.
//
// WHY IT IS DEBOUNCED
//
// GUILD_CREATE arrives once per guild in a burst at startup — 16 of them
// today, more later — and again on every gateway reconnect. Setting a
// presence per event would mean N gateway writes in a second to publish one
// number that only changes once. The debounce collapses a burst into a
// single update.

import { eq } from "drizzle-orm";
import { ActivityTypes } from "@discordeno/bot";

import { schema } from "../db/client.ts";
import { countRows } from "../db/count.ts";
import { logger } from "../utils/logger.ts";
import type { AppealyBot } from "./client.ts";

/** Long enough to swallow a reconnect burst, short enough that a join or
 *  leave shows up while the person who caused it is still looking. */
const DEBOUNCE_MS = 10_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let lastPublished: number | null = null;

/**
 * The gateway manager's presence method, if this build has one.
 *
 * Same caution as client.ts's totalShards assignment, for the same reason:
 * Discordeno's gateway manager has moved shape between minor versions, and a
 * missing method here would otherwise be a silent no-op — the bot connects,
 * shows no status, and nothing anywhere says why. Looked up defensively so a
 * version bump degrades to one log line instead of a mystery.
 */
function editBotStatus(bot: AppealyBot) {
  const gw = (bot as unknown as {
    gateway?: { editBotStatus?: (data: unknown) => Promise<void> };
  }).gateway;
  return typeof gw?.editBotStatus === "function" ? gw.editBotStatus.bind(gw) : null;
}

async function publish(bot: AppealyBot): Promise<void> {
  const edit = editBotStatus(bot);
  if (!edit) {
    logger.error(
      "This Discordeno build exposes no gateway.editBotStatus — the server count will not appear " +
        "on the bot's profile. Check @discordeno/gateway's manager API for the current name.",
    );
    return;
  }

  const servers = await countRows(schema.guilds, eq(schema.guilds.botPresent, true));

  // Nothing changed — a reconnect re-publishing the same number is a gateway
  // write for no reason.
  if (servers === lastPublished) return;

  try {
    await edit({
      status: "online",
      // created_at is deliberately absent: StatusUpdate omits it, and sending
      // it is rejected rather than ignored.
      activities: [{ name: `${servers} ${servers === 1 ? "server" : "servers"}`, type: ActivityTypes.Watching }],
    });
    lastPublished = servers;
    logger.info("Presence updated", { servers });
  } catch (err) {
    // A failed presence write is cosmetic. It must never take down the caller,
    // which is a guild-join handler in the middle of a startup burst.
    logger.warn("Failed to update presence", { error: String(err) });
  }
}

/**
 * Refreshes "Watching N servers", collapsing a burst of calls into one write.
 *
 * Safe to call from every guild join and leave; the debounce is the point.
 */
export function refreshPresence(bot: AppealyBot): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void publish(bot);
  }, DEBOUNCE_MS);
}

/**
 * Publishes immediately, for startup.
 *
 * Separate from refreshPresence because waiting the debounce at boot would
 * leave the bot with no status for the first ten seconds every deploy, which
 * is exactly when someone is watching to see whether the deploy worked.
 */
export async function publishPresenceNow(bot: AppealyBot): Promise<void> {
  await publish(bot);
}
