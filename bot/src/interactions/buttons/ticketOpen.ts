// bot/src/interactions/buttons/ticketOpen.ts
// Fires when a user clicks a ticket-panel's "Open Ticket" button.

import type { AppealyBot } from "../../core/client.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import { openTicket } from "../../services/ticketService.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleTicketOpenButton(
  bot: AppealyBot,
  interaction: Interaction,
  configId: string,
) {
  const guildId = interaction.guildId;
  const opener = interaction.member?.user ?? interaction.user;
  if (!guildId || !opener) return;

  // openTicket() creates a channel or thread and adds a member — two REST
  // round trips plus several queries. On 2026-08-23 this exceeded the
  // three-second window repeatedly: the ticket was created, and the user was
  // told the interaction failed, so they opened another one.
  await defer(bot, interaction, { ephemeral: true });

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
    return finish(bot, interaction, message);
  }

  await finish(bot, interaction, `Your ticket has been created: <#${result.channelId}>`);
}
