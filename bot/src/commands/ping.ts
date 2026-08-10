// bot/src/commands/ping.ts
// /ping — basic latency check. Small, but the kind of thing every admin
// expects to exist on day one to sanity-check the bot is alive and
// responsive before troubleshooting anything else.

import { ApplicationCommandTypes } from "@discordeno/bot";
import type { Interaction, CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";

const EPHEMERAL = 64;

export const definition: CreateApplicationCommand = {
  name: "ping",
  description: "Check the bot's latency",
  type: ApplicationCommandTypes.ChatInput,
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const sentAt = Date.now();
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content: "Pinging...", flags: EPHEMERAL },
  });
  const roundTripMs = Date.now() - sentAt;
  await bot.helpers.editOriginalInteractionResponse(interaction.token, {
    content: `Pong! Round-trip: ${roundTripMs}ms`,
  });
}
