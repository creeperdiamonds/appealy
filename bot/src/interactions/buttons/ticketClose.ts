// bot/src/interactions/buttons/ticketClose.ts
// Close and Claim buttons attached to every ticket's welcome message.

import { eq } from "drizzle-orm";
import type { Interaction } from "@discordeno/bot";
import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { closeTicket } from "../../services/ticketService.ts";
import { canManageTicket } from "../../services/permissionService.ts";
import { logger } from "../../utils/logger.ts";

const EPHEMERAL = 64;

export async function handleTicketCloseButton(
  bot: AppealyBot,
  interaction: Interaction,
  ticketId: string,
) {
  const guildId = interaction.guildId;
  const actor = interaction.member?.user ?? interaction.user;
  if (!guildId || !actor) return;

  const ticket = await db.query.tickets.findFirst({
    where: eq(schema.tickets.id, ticketId),
    with: { config: true },
  });
  if (!ticket) return respond(bot, interaction, "This ticket no longer exists.");
  if (ticket.status === "closed") return respond(bot, interaction, "This ticket is already closed.");

  const isStaff = await canManageTicket(
    guildId,
    ticket.config,
    actor.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions ?? 0n,
  );
  const isOpener = ticket.openerId === actor.id;
  // creatorCanClose gates whether the opener themselves may close — staff
  // can always close regardless of that setting.
  const allowed = isStaff || (isOpener && ticket.config.creatorCanClose);
  if (!allowed) {
    return respond(bot, interaction, "You don't have permission to close this ticket.");
  }

  await respond(bot, interaction, "Closing this ticket...");

  const result = await closeTicket(bot, ticketId, actor.id, undefined);
  if (result?.transcriptUrl) {
    logger.info("Ticket closed with transcript", { ticketId, transcriptUrl: result.transcriptUrl });
  }
}

export async function handleTicketRateButton(
  bot: AppealyBot,
  interaction: Interaction,
  ticketId: string,
  ratingStr: string | undefined,
) {
  const rating = Number(ratingStr);
  if (!ratingStr || Number.isNaN(rating) || rating < 1 || rating > 5) return;

  const { recordRating } = await import("../../services/ticketRatingService.ts");
  const recorded = await recordRating(ticketId, rating);

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: {
      content: recorded ? `Thanks for the ${"⭐".repeat(rating)} rating!` : "This ticket could not be found.",
      flags: EPHEMERAL,
    },
  });
}

export async function handleTicketClaimButton(
  bot: AppealyBot,
  interaction: Interaction,
  ticketId: string,
) {
  const guildId = interaction.guildId;
  const actor = interaction.member?.user ?? interaction.user;
  if (!guildId || !actor) return;

  const ticket = await db.query.tickets.findFirst({
    where: eq(schema.tickets.id, ticketId),
    with: { config: true },
  });
  if (!ticket || ticket.status === "closed") {
    return respond(bot, interaction, "This ticket is not open.");
  }

  const allowed = await canManageTicket(
    guildId,
    ticket.config,
    actor.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions ?? 0n,
  );
  if (!allowed) {
    return respond(bot, interaction, "Only support staff can claim tickets.");
  }

  await db.update(schema.tickets).set({ claimedBy: actor.id }).where(eq(schema.tickets.id, ticketId));
  await bot.helpers.sendMessage(ticket.channelId, {
    content: `🙋 <@${actor.id}> has claimed this ticket.`,
  });
  await respond(bot, interaction, "You claimed this ticket.");
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
