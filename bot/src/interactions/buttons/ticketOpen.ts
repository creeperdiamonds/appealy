// bot/src/interactions/buttons/ticketOpen.ts
// Fires when a user clicks a ticket-panel's "Open Ticket" button.

import type { Interaction } from "@discordeno/bot";
import type { AppealyBot } from "../../core/client.ts";
import { openTicket } from "../../services/ticketService.ts";

const EPHEMERAL = 64;

export async function handleTicketOpenButton(
  bot: AppealyBot,
  interaction: Interaction,
  configId: string,
) {
  const guildId = interaction.guildId;
  const opener = interaction.member?.user ?? interaction.user;
  if (!guildId || !opener) return;

  const result = await openTicket(bot, guildId, configId, opener.id, opener.username);

  if (!result.ok) {
    const message =
      result.reason === "max_open_reached"
        ? "You already have an open ticket for this. Please use your existing ticket."
        : result.reason === "config_inactive"
        ? "This ticket type is not currently accepting new tickets."
        : result.reason === "guild_rate_limited"
        ? "This server has reached its daily ticket limit. Please try again tomorrow, or ask staff about raising the limit."
        : "Something went wrong creating your ticket. Please contact staff directly.";
    return respond(bot, interaction, message);
  }

  await respond(bot, interaction, `Your ticket has been created: <#${result.channelId}>`);
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
