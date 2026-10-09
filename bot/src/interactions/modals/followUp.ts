// bot/src/interactions/modals/followUp.ts
//
// Follow-up questions, the submitted halves (the modals they come from are
// opened in interactions/buttons/reviewAsk.ts):
//
//   handleAskSubmit     staff asked: DM the applicant, note it for staff
//   handleAnswerSubmit  the applicant answered: show staff
//
// Staff see both in the submission's staff thread, or as a reply to the
// review post when the form has no threads, so the conversation sits next to
// the application it's about. Questions are only for pending submissions, and
// each one is answered once.

import { and, eq, isNull } from "drizzle-orm";
import { encodeCustomId } from "../../../../shared/types/index.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import type { AppealyBot } from "../../core/client.ts";
import { getGuild } from "../../core/guildLookup.ts";
import { db, schema } from "../../db/client.ts";
import { canReviewForm } from "../../services/permissionService.ts";
import { logger } from "../../utils/logger.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

type Submission = typeof schema.submissions.$inferSelect & { form: typeof schema.forms.$inferSelect };

export async function handleAskSubmit(bot: AppealyBot, interaction: Interaction, submissionId: string) {
  const guildId = interaction.guildId;
  const asker = interaction.member?.user ?? interaction.user;
  if (!guildId || !asker) return;

  await defer(bot, interaction, { ephemeral: true });

  const question = textValue(interaction);
  if (!question) return finish(bot, interaction, "The question was empty, so nothing was sent.");

  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, submissionId),
    with: { form: true },
  });
  if (!submission) return finish(bot, interaction, "This submission no longer exists.");
  if (submission.status !== "pending") {
    return finish(bot, interaction, `This was already marked **${submission.status}**, so questions are closed.`);
  }
  const allowed = await canReviewForm(
    guildId,
    submission.formId,
    asker.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions?.bitfield ?? 0n,
  );
  if (!allowed) return finish(bot, interaction, "Only reviewers can ask the applicant questions.");

  const [followup] = await db
    .insert(schema.submissionFollowups)
    .values({ submissionId, guildId, askerId: asker.id, question })
    .returning({ id: schema.submissionFollowups.id });

  const guildName = (await getGuild(bot, guildId))?.name ?? "the server";
  let delivered = true;
  try {
    const dm = await bot.helpers.getDmChannel(submission.applicantId);
    await bot.helpers.sendMessage(dm.id, {
      embeds: [
        {
          title: `A question about your ${submission.form.name} application`,
          description: question,
          color: 0x5865f2,
          footer: { text: `From the staff of ${guildName}` },
        },
      ],
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: "Answer", customId: encodeCustomId("submission", "answer", followup.id) },
          ],
        },
      ],
    } as never);
  } catch (err) {
    delivered = false;
    logger.warn("Couldn't DM a follow-up question", { submissionId, error: String(err) });
    // Nothing was sent, so there's nothing to answer: don't leave it open.
    await db.delete(schema.submissionFollowups).where(eq(schema.submissionFollowups.id, followup.id));
  }

  if (!delivered) {
    return finish(bot, interaction, "I couldn't DM the applicant: their DMs from this server are probably closed. Nothing was sent.");
  }
  await tellStaff(bot, submission, `❓ <@${asker.id}> asked <@${submission.applicantId}>:\n>>> ${question}`);
  return finish(bot, interaction, "Sent! Their answer will show up here for staff.");
}

export async function handleAnswerSubmit(bot: AppealyBot, interaction: Interaction, followupId: string) {
  const answerer = interaction.user ?? interaction.member?.user;
  if (!answerer) return;

  await defer(bot, interaction, { ephemeral: true });

  const answer = textValue(interaction);
  if (!answer) return finish(bot, interaction, "Your answer was empty, so nothing was sent.");

  const followup = await db.query.submissionFollowups.findFirst({ where: eq(schema.submissionFollowups.id, followupId) });
  if (!followup) return finish(bot, interaction, "This question no longer exists.");
  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, followup.submissionId),
    with: { form: true },
  });
  if (!submission || submission.applicantId !== answerer.id) return finish(bot, interaction, "This question isn't for you.");
  if (submission.status !== "pending") {
    return finish(bot, interaction, `Your application was already **${submission.status}**, so there's no need to answer.`);
  }

  // Answered once: the update only lands if nobody answered first.
  const [saved] = await db
    .update(schema.submissionFollowups)
    .set({ answer, answeredAt: new Date() })
    .where(and(eq(schema.submissionFollowups.id, followupId), isNull(schema.submissionFollowups.answeredAt)))
    .returning({ id: schema.submissionFollowups.id });
  if (!saved) return finish(bot, interaction, "You already answered this question.");

  await tellStaff(
    bot,
    submission,
    `💬 <@${submission.applicantId}> answered <@${followup.askerId}>'s question:\n> ${followup.question.slice(0, 300).replace(/\n/g, "\n> ")}\n>>> ${answer}`,
  );
  return finish(bot, interaction, "Thanks! Your answer was sent to the staff.");
}

/**
 * Into the staff thread, or as a reply to the review post without one. Names
 * people without pinging them: staff are reading the thread already, and the
 * applicant must never be pinged into a staff channel.
 */
async function tellStaff(bot: AppealyBot, submission: Submission, content: string) {
  const target = submission.threadId ?? submission.form.logChannelId;
  try {
    await bot.helpers.sendMessage(target, {
      content: content.slice(0, 2000),
      allowedMentions: { parse: [] },
      ...(!submission.threadId && submission.logMessageId
        ? { messageReference: { messageId: submission.logMessageId, failIfNotExists: false } }
        : {}),
    } as never);
  } catch (err) {
    logger.warn("Couldn't post a follow-up to staff", { submissionId: submission.id, error: String(err) });
  }
}

/** The one text input in these modals. */
function textValue(interaction: Interaction): string {
  const row = interaction.data?.components?.[0] as { components?: { value?: string }[] } | undefined;
  return row?.components?.[0]?.value?.trim() ?? "";
}
