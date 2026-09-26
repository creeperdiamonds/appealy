// bot/src/events/guildMemberUpdate.ts
//
// Timeout and restriction appeals. When a member is timed out, or given one of
// the roles a server's punishment ladder hands out instead of a ban, DM them
// the same kind of notice a ban sends: what happened, and a button to appeal
// if they want to. Nobody is asked anything until they press it — see
// interactions/buttons/appealStart.ts for why.
//
// Discord fires this event for nicknames, avatars and every role change, so
// the path is kept cheap: the guild's appeal settings come from the cached
// config bundle, and the database is only touched in guilds that turned one
// of these on. appeal_notices makes each punishment notice exactly once (see
// its schema comment); shared/services/appealTriggers.ts decides what an
// update means.
//
// Requires the GuildMembers intent (bot/src/core/client.ts).

import { and, eq, inArray } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { getGuildConfig } from "../core/guildConfigCache.ts";
import { getGuild } from "../core/guildLookup.ts";
import { logger } from "../utils/logger.ts";
import { diffRestrictionNotices, timeoutNoticeKey } from "../../../shared/services/appealTriggers.ts";
import { CUSTOM_ID_NAMESPACES, encodeCustomId } from "../../../shared/types/index.ts";

type AppealConfig = typeof schema.appealConfigs.$inferSelect;
interface UpdatedMember {
  id: bigint;
  guildId?: bigint;
  roles?: bigint[];
  communicationDisabledUntil?: number;
}

export function onGuildMemberUpdate(bot: AppealyBot) {
  return async (member: UpdatedMember) => {
    const guildId = member.guildId;
    if (!guildId) return;
    try {
      // `?? null`: a bundle cached before appeal settings joined it has no
      // such field until it expires.
      const config = (await getGuildConfig(guildId)).appeal ?? null;
      if (!config) return;
      if (config.timeoutEnabled && config.timeoutFormId) {
        await noticeTimeout(bot, config, guildId, member.id, member.communicationDisabledUntil);
      }
      if (config.restrictionEnabled && config.restrictionFormId && config.restrictionRoleIds.length > 0) {
        await noticeRestrictions(bot, config, guildId, member.id, (member.roles ?? []).map(String));
      }
    } catch (err) {
      // Best-effort, exactly like the ban notice: never let this take down
      // the gateway event loop.
      logger.error("Failed while checking a member update for appeal notices", {
        guildId: guildId.toString(),
        userId: member.id.toString(),
        error: String(err),
      });
    }
  };
}

async function noticeTimeout(
  bot: AppealyBot,
  config: AppealConfig,
  guildId: bigint,
  userId: bigint,
  untilMs: number | undefined,
) {
  const key = timeoutNoticeKey(untilMs, Date.now(), config.timeoutMinSeconds);
  if (!key) return;

  // The insert is the lock: two gateway updates for the same timeout race to
  // it, and only the one that actually inserted sends the DM.
  const claimed = await db
    .insert(schema.appealNotices)
    .values({ guildId, userId, kind: "timeout", key })
    .onConflictDoNothing()
    .returning({ key: schema.appealNotices.key });
  if (claimed.length === 0) return;

  const guildName = (await getGuild(bot, guildId))?.name ?? "a server";
  const endsAt = `<t:${Math.floor(Number(key) / 1000)}:f>`;
  const notice = config.dmOnTimeoutNote?.trim()
    ? `${config.dmOnTimeoutNote}\n-# Timed out until ${endsAt}.`
    : `You have been timed out in **${guildName}** until ${endsAt}. If you think that was a mistake, you can appeal using the button below. You do not have to.`;

  const sent = await sendNotice(
    bot,
    userId,
    notice,
    "Appeal this timeout",
    encodeCustomId(CUSTOM_ID_NAMESPACES.APPEAL, "timeout", guildId.toString(), config.timeoutFormId!),
  );
  logger.info("Sent (or attempted) timeout appeal notice", {
    guildId: guildId.toString(),
    userId: userId.toString(),
    delivered: sent,
  });
}

async function noticeRestrictions(
  bot: AppealyBot,
  config: AppealConfig,
  guildId: bigint,
  userId: bigint,
  memberRoleIds: string[],
) {
  const notices = await db
    .select({ key: schema.appealNotices.key })
    .from(schema.appealNotices)
    .where(
      and(
        eq(schema.appealNotices.guildId, guildId),
        eq(schema.appealNotices.userId, userId),
        eq(schema.appealNotices.kind, "restriction"),
      ),
    );
  const { notify, clear } = diffRestrictionNotices(
    memberRoleIds,
    config.restrictionRoleIds,
    notices.map((n) => n.key),
  );

  if (clear.length > 0) {
    await db
      .delete(schema.appealNotices)
      .where(
        and(
          eq(schema.appealNotices.guildId, guildId),
          eq(schema.appealNotices.userId, userId),
          eq(schema.appealNotices.kind, "restriction"),
          inArray(schema.appealNotices.key, clear),
        ),
      );
  }
  if (notify.length === 0) return;

  const guild = await getGuild(bot, guildId);
  const guildName = guild?.name ?? "a server";
  for (const roleId of notify) {
    const claimed = await db
      .insert(schema.appealNotices)
      .values({ guildId, userId, kind: "restriction", key: roleId })
      .onConflictDoNothing()
      .returning({ key: schema.appealNotices.key });
    if (claimed.length === 0) continue;

    const roleName = guild?.roles?.get(BigInt(roleId))?.name;
    const notice = config.dmOnRestrictionNote?.trim()
      ? `${config.dmOnRestrictionNote}${roleName ? `\n-# Restriction: ${roleName}` : ""}`
      : `You were given ${roleName ? `the **${roleName}** role` : "a restriction role"} in **${guildName}**, which limits what you can do there. If you think that was a mistake, you can appeal using the button below. You do not have to.`;

    // One button per role: a member under two restrictions appeals each on
    // its own, and accepting one appeal lifts only that role.
    const sent = await sendNotice(
      bot,
      userId,
      notice,
      "Appeal this restriction",
      encodeCustomId(CUSTOM_ID_NAMESPACES.APPEAL, "role", guildId.toString(), `${config.restrictionFormId}.${roleId}`),
    );
    logger.info("Sent (or attempted) restriction appeal notice", {
      guildId: guildId.toString(),
      userId: userId.toString(),
      roleId,
      delivered: sent,
    });
  }
}

async function sendNotice(bot: AppealyBot, userId: bigint, content: string, label: string, customId: string) {
  const { dmOrLog } = await import("../services/dmApplicationService.ts");
  return await dmOrLog(bot, userId, content, [
    {
      type: 1, // action row
      components: [{ type: 2, style: 1, label, customId }], // primary button
    },
  ]);
}
