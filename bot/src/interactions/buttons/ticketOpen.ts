// bot/src/interactions/buttons/ticketOpen.ts
// Fires when a user clicks a ticket-panel button, or submits the questions a
// category asks first (the pop-up itself is opened by ticketAsk.ts).

import type { AppealyBot } from "../../core/client.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import { openTicket } from "../../services/ticketService.ts";
import { readModalAnswers } from "../../services/modalAnswers.ts";
import { db, schema } from "../../db/client.ts";
import { and, eq } from "drizzle-orm";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleTicketOpenButton(
  bot: AppealyBot,
  interaction: Interaction,
  configId: string,
  categoryId?: string,
) {
  const guildId = interaction.guildId;
  const opener = interaction.member?.user ?? interaction.user;
  if (!guildId || !opener) return;

  // openTicket() creates a channel or thread and adds a member — two REST
  // round trips plus several queries. On 2026-08-23 this exceeded the
  // three-second window repeatedly: the ticket was created, and the user was
  // told the interaction failed, so they opened another one.
  await defer(bot, interaction, { ephemeral: true });

  const result = await openTicket(bot, guildId, configId, opener.id, opener.username, { categoryId });
  await report(bot, interaction, result);
}

/** The pop-up a category asks before opening (ticket:submit:<configId>:<categoryId>). */
export async function handleTicketModalSubmit(
  bot: AppealyBot,
  interaction: Interaction,
  configId: string,
  categoryId: string,
) {
  const guildId = interaction.guildId;
  const opener = interaction.member?.user ?? interaction.user;
  if (!guildId || !opener) return;

  await defer(bot, interaction, { ephemeral: true });

  const category = await db.query.ticketCategories.findFirst({
    where: and(eq(schema.ticketCategories.id, categoryId), eq(schema.ticketCategories.configId, configId)),
  });
  if (!category) return finish(bot, interaction, "This ticket option no longer exists.");

  // Inputs are numbered by position (q0, q1…), the same ids ticketAsk.ts gave them.
  const typed = readModalAnswers(interaction.data?.components as never);
  const answers = category.questions.map((q, i) => ({ label: q.label, value: (typed[`q${i}`] ?? "").trim() }));

  const result = await openTicket(bot, guildId, configId, opener.id, opener.username, { categoryId, answers });
  await report(bot, interaction, result);
}

async function report(
  bot: AppealyBot,
  interaction: Interaction,
  result: Awaited<ReturnType<typeof openTicket>>,
) {
  if (!result.ok) {
    const message =
      result.reason === "max_open_reached"
        ? "You already have an open ticket for this. Please use your existing ticket."
        : result.reason === "config_inactive"
        ? "This ticket type is not currently accepting new tickets."
        : result.reason === "category_missing"
        ? "That option was removed by the server's staff. Please use the panel's current buttons."
        : result.reason === "missing_permission"
        ? "I'm not allowed to open tickets here. Please tell the server's staff: Appealy needs " +
          "Manage Channels for ticket channels, or Create Private Threads for thread tickets."
        : result.reason === "guild_rate_limited"
        ? "This server has reached its daily ticket limit. Please try again tomorrow, or ask staff about raising the limit."
        : "Something went wrong creating your ticket. Please contact staff directly.";
    return finish(bot, interaction, message);
  }

  await finish(bot, interaction, `Your ticket has been created: <#${result.channelId}>`);
}
