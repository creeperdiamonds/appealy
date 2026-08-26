// bot/src/interactions/buttons/ticketClose.ts
// Close and Claim buttons attached to every ticket's welcome message.

import { eq } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { closeTicket } from "../../services/ticketService.ts";
import { canManageTicket } from "../../services/permissionService.ts";
import { logger } from "../../utils/logger.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleTicketCloseButton(
  bot: AppealyBot,
  interaction: Interaction,
  ticketId: string,
) {
  const guildId = interaction.guildId;
  const actor = interaction.member?.user ?? interaction.user;
  if (!guildId || !actor) return;

  // The permission check alone is a query plus canManageTicket's own lookups,
  // and closeTicket() below generates a transcript, DMs a rating prompt and
  // archives or deletes the channel — several more REST round trips. On
  // 2026-08-23 this combination blew the three-second window the same way
  // ticketOpen did: the ticket closed successfully and the clicker was shown
  // "This interaction failed", so they clicked Close again.
  await defer(bot, interaction, { ephemeral: true });

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
    interaction.member?.permissions?.bitfield ?? 0n,
  );
  const isOpener = ticket.openerId === actor.id;
  // creatorCanClose gates whether the opener themselves may close — staff
  // can always close regardless of that setting.
  const allowed = isStaff || (isOpener && ticket.config.creatorCanClose);
  if (!allowed) {
    return respond(bot, interaction, "You don't have permission to close this ticket.");
  }

  // Do the actual closing work — and finish responding — as the LAST thing
  // in this function. The interim "Closing this ticket..." message this
  // handler used to send before doing the work is gone: it would now sit
  // between the deferral and closeTicket(), so if closeTicket() threw, the
  // router's catch handler would edit that message to "Something went
  // wrong" and tell the clicker their (successful) close had failed. See
  // interactionCreate.ts's error handler for why it edits rather than sends.
  const result = await closeTicket(bot, ticketId, actor.id, undefined);
  if (result?.transcriptUrl) {
    logger.info("Ticket closed with transcript", { ticketId, transcriptUrl: result.transcriptUrl });
  }

  await respond(bot, interaction, "Ticket closed.");
}

export async function handleTicketRateButton(
  bot: AppealyBot,
  interaction: Interaction,
  ticketId: string,
  ratingStr: string | undefined,
) {
  const rating = Number(ratingStr);
  if (!ratingStr || Number.isNaN(rating) || rating < 1 || rating > 5) return;

  // recordRating() is reached through a dynamic import and is itself a DB
  // write — deferring keeps this path consistent with the rest of the file
  // rather than leaving one button relying on the query being fast enough.
  await defer(bot, interaction, { ephemeral: true });

  const { recordRating } = await import("../../services/ticketRatingService.ts");
  const recorded = await recordRating(ticketId, rating);

  await respond(
    bot,
    interaction,
    recorded ? `Thanks for the ${"⭐".repeat(rating)} rating!` : "This ticket could not be found.",
  );
}

export async function handleTicketClaimButton(
  bot: AppealyBot,
  interaction: Interaction,
  ticketId: string,
) {
  const guildId = interaction.guildId;
  const actor = interaction.member?.user ?? interaction.user;
  if (!guildId || !actor) return;

  // Same shape as the close handler: a ticket lookup, a permission check,
  // a role/DB update and a channel announcement all happen before this can
  // answer — deferring keeps claiming from racing the three-second window.
  await defer(bot, interaction, { ephemeral: true });

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
    interaction.member?.permissions?.bitfield ?? 0n,
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

// Kept as a one-line wrapper rather than rewriting every call site: the
// ephemeral flag now lives on the deferral, so there is nothing left for
// this to decide.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
