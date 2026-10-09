// bot/src/services/setupCheck.ts
//
// Feeds the dashboard's setup check (services/setupRules.ts) with what it
// needs: the server from Discord, its active forms from the database.

import { and, eq, inArray } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { checkSetup, type SetupGuild, type SetupIssue } from "./setupRules.ts";

/** Reads the server from Discord and its active forms from the database, then checks them. */
export async function runSetupCheck(bot: AppealyBot, guildId: bigint): Promise<SetupIssue[]> {
  const forms = await db.query.forms.findMany({ where: and(eq(schema.forms.guildId, guildId), eq(schema.forms.active, true)) });
  if (forms.length === 0) return [];
  const outcomes = await db.query.formOutcomes.findMany({ where: inArray(schema.formOutcomes.formId, forms.map((f) => f.id)) });

  const [guild, channels, me] = await Promise.all([
    bot.rest.getGuild(guildId),
    bot.rest.getChannels(guildId),
    bot.rest.getMember(guildId, bot.id),
  ]);

  const g: SetupGuild = {
    id: guildId.toString(),
    ownerId: String(guild.ownerId),
    botId: bot.id.toString(),
    botRoleIds: me.roles.map(String),
    roles: guild.roles.map((r) => ({
      id: String(r.id),
      name: r.name,
      position: r.position,
      permissions: BigInt(r.permissions),
      managed: r.managed,
    })),
    channels: channels.map((c) => ({
      id: String(c.id),
      name: c.name ?? "",
      overwrites: (c.permissionOverwrites ?? []).map((o) => ({
        type: Number(o.type),
        id: String(o.id),
        allow: BigInt(o.allow ?? "0"),
        deny: BigInt(o.deny ?? "0"),
      })),
    })),
  };

  return checkSetup(
    g,
    forms.map((f) => {
      const mine = outcomes.filter((o) => o.formId === f.id);
      return {
        id: f.id,
        name: f.name,
        logChannelId: f.logChannelId.toString(),
        acceptedChannelId: f.acceptedChannelId?.toString() ?? null,
        deniedChannelId: f.deniedChannelId?.toString() ?? null,
        threads: f.threadCollabEnabled,
        archiveOnDecision: f.autoArchiveOnDecision,
        roleIds: [
          ...f.grantRoleIds, ...f.removeRoleIds, ...f.deniedGrantRoleIds, ...f.denyRemoveRoleIds, ...f.pendingRoleIds,
          ...mine.flatMap((o) => [...o.grantRoleIds, ...o.removeRoleIds]),
        ],
        outcomeChannelIds: mine.flatMap((o) => (o.logChannelId ? [o.logChannelId.toString()] : [])),
      };
    }),
  );
}
