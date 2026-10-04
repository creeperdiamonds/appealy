// bot/src/services/tempBans.ts
//
// Bans with an end ("?ban @user 7d"). The end is a row in temp_bans, and the
// scheduler (core/scheduler.ts) unbans once it passes. A row rather than a
// timer so a restart in between doesn't turn a week's ban into a permanent one.

import { and, eq, lte } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { describeDiscordError } from "../utils/discordError.ts";
import { logger } from "../utils/logger.ts";

/** Records when a ban should end. Replaces any earlier end for the same member. */
export async function scheduleUnban(guildId: bigint, userId: bigint, unbanAt: Date, bannedBy: bigint): Promise<void> {
  await db
    .insert(schema.tempBans)
    .values({ guildId, userId, unbanAt, bannedBy })
    .onConflictDoUpdate({
      target: [schema.tempBans.guildId, schema.tempBans.userId],
      set: { unbanAt, bannedBy, createdAt: new Date() },
    });
}

/**
 * Forgets a scheduled unban: the member was unbanned early, or banned again
 * for good. Without this a later permanent ban would still be lifted when the
 * old timer ran out.
 */
export async function cancelUnban(guildId: bigint, userId: bigint): Promise<void> {
  await db.delete(schema.tempBans).where(and(eq(schema.tempBans.guildId, guildId), eq(schema.tempBans.userId, userId)));
}

/** Lifts every ban whose time is up. Run by the scheduler each tick. */
export async function unbanDueTempBans(bot: AppealyBot): Promise<void> {
  const due = await db.select().from(schema.tempBans).where(lte(schema.tempBans.unbanAt, new Date())).limit(50);
  for (const row of due) {
    try {
      await bot.helpers.unbanMember(row.guildId, row.userId, `Temporary ban ended (banned by ${row.bannedBy})`);
    } catch (err) {
      const info = describeDiscordError(err);
      // 10026 Unknown Ban: already unbanned by hand. Anything else (Appealy
      // removed, permission lost) won't fix itself by retrying every 30 s,
      // so the row goes either way and the failure is logged.
      if (info.code !== 10026) {
        logger.warn("Couldn't end a temporary ban", {
          guildId: row.guildId.toString(),
          userId: row.userId.toString(),
          status: info.status,
          code: info.code,
          detail: info.message,
        });
      }
    }
    await cancelUnban(row.guildId, row.userId);
  }
}
