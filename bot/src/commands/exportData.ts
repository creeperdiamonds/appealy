// bot/src/commands/exportData.ts
//
// /export — owner-only full data export, DMed as a JSON file attachment.
// Owner-only (not admin/manager) is deliberate: some server owners want
// the assurance that a complete data dump can only be pulled by them
// specifically, not by any admin they've delegated day-to-day management
// to. See permissionService.ts::isGuildOwner and the matching dashboard
// middleware for the same rule enforced on the API side.
//
// Sent via DM rather than posted in a channel, since this can contain
// applicant answers, verification attempts, and other data that
// shouldn't land in a public or even a staff-only channel's permanent
// history.

import { ApplicationCommandTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import { getGuild } from "../core/guildLookup.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { isGuildOwner } from "../services/permissionService.ts";
import { buildFullDataExport } from "../services/dataExportService.ts";
import { logger } from "../utils/logger.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

export const definition: CreateApplicationCommand = {
  name: "export",
  description: "Export all of this server's Appealy data as a JSON file (owner only)",
  type: ApplicationCommandTypes.ChatInput,
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const requester = interaction.member?.user ?? interaction.user;
  if (!guildId || !requester) return;

  // isGuildOwner is a REST call and buildFullDataExport below does a full
  // pass over the guild's data — either can outrun Discord's three-second
  // first-response window. Deferring buys fifteen minutes.
  await defer(bot, interaction, { ephemeral: true });

  const isOwner = await isGuildOwner(bot, guildId, requester.id);
  if (!isOwner) {
    return respond(bot, interaction, "Only the server owner can run a full data export.");
  }

  await respond(bot, interaction, "Building your export — I'll DM you the file shortly.");

  try {
    const exportData = await buildFullDataExport(guildId);
    const json = JSON.stringify(exportData, null, 2);
    const fileBytes = new TextEncoder().encode(json);

    const guildName = (await getGuild(bot, guildId))?.name ?? guildId.toString();
    const filename = `appealy-export-${guildName.replace(/[^a-z0-9]/gi, "_")}-${new Date().toISOString().slice(0, 10)}.json`;

    const dmChannel = await bot.helpers.getDmChannel(requester.id);
    await bot.helpers.sendMessage(dmChannel.id, {
      content: `Here's your full data export for **${guildName}**. This includes forms, panels, submissions, tickets, and every other Appealy config for this server — keep it somewhere safe, it contains applicant answers and other member data.`,
      // Renamed to a list in Discordeno v19+; a single-element array is the
      // same request.
      files: [
        {
          blob: new Blob([fileBytes], { type: "application/json" }),
          name: filename,
        },
      ],
    });

    logger.info("Full data export completed", { guildId: guildId.toString(), requesterId: requester.id.toString() });
  } catch (err) {
    logger.error("Failed to build/send data export", { guildId: guildId.toString(), error: String(err) });
    try {
      const dmChannel = await bot.helpers.getDmChannel(requester.id);
      await bot.helpers.sendMessage(dmChannel.id, {
        content: "Something went wrong building your export. Please try again, or reach out if this keeps happening.",
      });
    } catch {
      // DMs closed — nothing more we can do; the ephemeral "building" message is the only feedback they'll get
    }
  }
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
