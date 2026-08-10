// bot/src/commands/dashboard.ts
// /dashboard — sends the applicant/admin a link to the web dashboard,
// scoped to the current guild.

import { ApplicationCommandTypes } from "@discordeno/bot";
import type { Interaction, CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";

const EPHEMERAL = 64;
const DASHBOARD_BASE_URL = Deno.env.get("DASHBOARD_BASE_URL") ?? "https://dashboard.appealy.app";

export const definition: CreateApplicationCommand = {
  name: "dashboard",
  description: "Get a link to the Appealy web dashboard for this server",
  type: ApplicationCommandTypes.ChatInput,
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: {
      flags: EPHEMERAL,
      content: `Manage forms, panels, and polls here: ${DASHBOARD_BASE_URL}/guilds/${guildId}`,
    },
  });
}
