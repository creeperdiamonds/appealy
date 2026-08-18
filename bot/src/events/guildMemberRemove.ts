// bot/src/events/guildMemberRemove.ts
//
// Fires when a member leaves (or is kicked/banned from) a guild. Applies
// each pending submission's configured `leaveAction`:
//   - "none": leave the submission pending, untouched.
//   - "deny_application": auto-deny it. Skips DM (they've left, DMs will
//     usually fail anyway) and skips role changes (they're no longer a
//     member, role calls would just 404), but still records the decision,
//     edits the review post, and archives the staff thread so the queue
//     doesn't accumulate stale entries for people who are gone.

import { eq, and } from "drizzle-orm";
import { getGuild } from "../core/guildLookup.ts";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { closeTicket } from "../services/ticketService.ts";
import { interpolateTemplate } from "../../../shared/types/index.ts";
import { logger } from "../utils/logger.ts";

export function onGuildMemberRemove(bot: AppealyBot) {
  return async (payload: { guildId: bigint; user: { id: bigint; username?: string } }) => {
    await handleApplicationLeaveActions(bot, payload);
    await handleTicketLeaveActions(bot, payload);
    await handleWelcomerLeaveMessage(bot, payload);
  };
}

async function handleWelcomerLeaveMessage(
  bot: AppealyBot,
  payload: { guildId: bigint; user: { id: bigint; username?: string } },
) {
  const config = await db.query.welcomerConfigs.findFirst({ where: eq(schema.welcomerConfigs.guildId, payload.guildId) });
  if (!config || !config.leaveEnabled || !config.leaveChannelId) return;

  const guild = await getGuild(bot, payload.guildId);
  const message = interpolateTemplate(config.leaveMessage ?? "{username} has left {guild}.", {
    username: payload.user.username ?? "Someone",
    userTag: payload.user.username ?? "Someone",
    userId: payload.user.id.toString(),
    guildName: guild?.name ?? "the server",
    memberCount: guild?.memberCount,
  });

  try {
    await bot.helpers.sendMessage(config.leaveChannelId, { content: message });
  } catch (err) {
    logger.warn("Failed to send welcomer leave message", { error: String(err) });
  }
}

async function handleApplicationLeaveActions(
  bot: AppealyBot,
  payload: { guildId: bigint; user: { id: bigint } },
) {
    const pending = await db
      .select({ submission: schema.submissions, form: schema.forms })
      .from(schema.submissions)
      .innerJoin(schema.forms, eq(schema.forms.id, schema.submissions.formId))
      .where(
        and(
          eq(schema.submissions.guildId, payload.guildId),
          eq(schema.submissions.applicantId, payload.user.id),
          eq(schema.submissions.status, "pending"),
        ),
      );

    for (const { submission, form } of pending) {
      if (form.leaveAction !== "deny_application") continue;

      await db
        .update(schema.submissions)
        .set({
          status: "denied",
          reviewReason: "Applicant left the server before a decision was made.",
          reviewedAt: new Date(),
        })
        .where(eq(schema.submissions.id, submission.id));

      if (submission.logMessageId) {
        try {
          await bot.helpers.editMessage(form.logChannelId, submission.logMessageId, {
            embeds: [
              {
                title: `Application — ${form.name} (Auto-denied)`,
                description: `<@${payload.user.id}> left the server before this application was reviewed.`,
                color: 0xed4245,
                footer: { text: `Submission ID: ${submission.id}` },
              },
            ],
            components: [],
          });
        } catch (err) {
          logger.warn("Failed to edit review message on member-leave auto-deny", {
            submissionId: submission.id,
            error: String(err),
          });
        }
      }

      if (form.autoArchiveOnDecision && submission.threadId) {
        try {
          await bot.helpers.editChannel(submission.threadId, { archived: true, locked: true });
        } catch {
          // non-fatal
        }
      }

      logger.info("Auto-denied pending application on member leave", {
        submissionId: submission.id,
        formId: form.id,
      });
    }
}

async function handleTicketLeaveActions(
  bot: AppealyBot,
  payload: { guildId: bigint; user: { id: bigint } },
) {
  const openTickets = await db
    .select({ ticket: schema.tickets, config: schema.ticketConfigs })
    .from(schema.tickets)
    .innerJoin(schema.ticketConfigs, eq(schema.ticketConfigs.id, schema.tickets.configId))
    .where(
      and(
        eq(schema.tickets.guildId, payload.guildId),
        eq(schema.tickets.openerId, payload.user.id),
        eq(schema.tickets.status, "open"),
      ),
    );

  for (const { ticket, config } of openTickets) {
    if (config.leaveAction === "none") continue;

    if (config.leaveAction === "notify") {
      try {
        await bot.helpers.sendMessage(ticket.channelId, {
          content: `⚠️ <@${payload.user.id}> has left the server. This ticket remains open — a staff member should follow up or close it.`,
        });
      } catch (err) {
        logger.warn("Failed to post leave notice in ticket", { ticketId: ticket.id, error: String(err) });
      }
      continue;
    }

    if (config.leaveAction === "close") {
      await closeTicket(bot, ticket.id, bot.id, "Applicant left the server.");
      logger.info("Auto-closed ticket on member leave", { ticketId: ticket.id });
    }
  }
}
