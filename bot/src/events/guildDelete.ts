// bot/src/events/guildDelete.ts
// Fires when the bot is removed from a guild, or the guild is deleted.
//
// This deliberately does NOT delete anything. Removing the bot — by accident,
// during a permissions cleanup, or for five minutes — must not cost a server
// every form, panel, submission and ticket they ever configured. The guilds
// row cascades to all of it, so deleting it here would be the single most
// destructive line in the codebase, triggered by an action that is often
// reversed within the hour.
//
// Instead the row is marked absent. Everything stays, the dashboard says the
// server needs an invite rather than showing a console whose every request
// would fail, and adding the bot back restores it exactly as it was.
//
// A caveat worth stating rather than discovering. Discord sends GUILD_DELETE
// both when the bot is removed AND when a guild goes temporarily unavailable
// during an outage, distinguished by an `unavailable` flag on the payload.
// Discordeno hands this handler the guild id and shard id only, so that flag is
// not available here — meaning a Discord outage marks affected guilds as
// departed and their dashboards will say "needs an invite" until the guild
// comes back and GUILD_CREATE clears the flag.
//
// That self-corrects within minutes and costs nothing but a confusing banner
// during an outage, which is why it is acceptable. Reading the raw payload
// would fix it properly if it ever becomes a real annoyance.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { logger } from "../utils/logger.ts";
import { forgetGuild } from "../core/guildLookup.ts";

export function onGuildDelete(_bot: unknown) {
  return async (guildId: bigint, _shardId: number) => {
    try {
      await db
        .update(schema.guilds)
        .set({ botPresent: false, updatedAt: new Date() })
        .where(eq(schema.guilds.id, guildId));

      // Drop the cached name/roles so a re-invite doesn't serve stale ones.
      forgetGuild(guildId);

      logger.info("Removed from guild; configuration kept", {
        guildId: guildId.toString(),
      });
    } catch (err) {
      logger.error("Failed to mark guild as departed", {
        guildId: guildId.toString(),
        error: String(err),
      });
    }
  };
}
