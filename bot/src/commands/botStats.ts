// bot/src/commands/botStats.ts
// /botstats — bot health and per-guild usage stats.

import { ApplicationCommandTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { countRows } from "../db/count.ts";
import { sql } from "drizzle-orm";
import { defer, finish } from "../utils/interactionResponse.ts";

const processStartedAt = Date.now();

export const definition: CreateApplicationCommand = {
  name: "botstats",
  description: "Show bot health and usage stats",
  type: ApplicationCommandTypes.ChatInput,
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;

  // Four count queries (guilds, plus three per-guild counts below) run
  // sequentially — cheap individually, but enough combined to risk
  // Discord's three-second first-response window. Deferring buys fifteen
  // minutes.
  await defer(bot, interaction, { ephemeral: true });

  const uptimeSeconds = Math.floor((Date.now() - processStartedAt) / 1000);
  const uptimeText = formatUptime(uptimeSeconds);

  let guildFormCount = 0;
  let guildSubmissionCount = 0;
  let guildOpenTicketCount = 0;
  if (guildId) {
    guildFormCount = await countRows(schema.forms, sql`${schema.forms.guildId} = ${guildId}`);
    guildSubmissionCount = await countRows(schema.submissions, sql`${schema.submissions.guildId} = ${guildId}`);
    guildOpenTicketCount = await countRows(
      schema.tickets,
      sql`${schema.tickets.guildId} = ${guildId} AND ${schema.tickets.status} = 'open'`,
    );
  }

  await finish(bot, interaction, {
    embeds: [
      {
        title: "Bot Stats",
        color: 0x5865f2,
        fields: [
          { name: "Uptime", value: uptimeText, inline: true },
          { name: "Guilds", value: String(await countRows(schema.guilds)), inline: true },
          { name: "This server's forms", value: String(guildFormCount), inline: true },
          { name: "This server's submissions", value: String(guildSubmissionCount), inline: true },
          { name: "This server's open tickets", value: String(guildOpenTicketCount), inline: true },
        ],
      },
    ],
  });
}

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}
