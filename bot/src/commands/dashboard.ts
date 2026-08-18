// bot/src/commands/dashboard.ts
// /dashboard — sends the applicant/admin a link to the web dashboard,
// scoped to the current guild.

import { ApplicationCommandTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";

const EPHEMERAL = 64;
// Defaulted to a subdomain that nothing serves. The console lives at
// /dashboard on the same origin as the marketing site — that is what the OAuth
// callback redirects to and what nginx routes — so a link to
// dashboard.appealy.app sent people somewhere that does not exist. One front
// door; DASHBOARD_BASE_URL overrides it for a deployment that really does split
// them across hosts.
const DASHBOARD_BASE_URL =
  Deno.env.get("DASHBOARD_BASE_URL") ?? "http://localhost:5173/dashboard";

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
