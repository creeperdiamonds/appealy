// bot/src/interactions/buttons/submissionWithdraw.ts
//
// The applicant's own Withdraw button, on their "submitted!" confirmation
// (an ephemeral reply for modal forms, a DM for DM forms). Two clicks:
// "Withdraw" asks, "Yes, withdraw" does it — an application is too much
// work to lose to a stray tap.
//
// Staff could already withdraw from the dashboard (api/src/routes/
// submissions.ts); this is the same status change, made by the applicant,
// plus the Discord side the api can't do: the review post stops offering
// Accept/Deny and says the applicant pulled it.
//
// Works in DMs as well as servers: everything it needs is in the custom id
// (the submission id) and the database, nothing in the interaction's guild.

import { and, eq } from "drizzle-orm";
import { encodeCustomId } from "../../../../shared/types/index.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { recordSubmissionEvent } from "../../services/submissionEvents.ts";
import { markReviewPost } from "../../services/reviewPost.ts";
import { logger } from "../../utils/logger.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

/** Grey: neither accepted nor denied. */
const WITHDRAWN_COLOR = 0x95a5a6;

/** The button added under a "submitted!" confirmation. */
export function withdrawButtonRow(submissionId: string) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2, // secondary: there, but not inviting
          label: "Withdraw application",
          customId: encodeCustomId("submission", "withdraw", submissionId),
        },
      ],
    },
  ];
}

/** "Withdraw" was clicked: ask first. */
export async function handleWithdrawAsk(bot: AppealyBot, interaction: Interaction, submissionId: string) {
  await defer(bot, interaction, { ephemeral: true });
  const found = await ownPending(interaction, submissionId);
  if ("error" in found) return finish(bot, interaction, found.error);
  return finish(bot, interaction, {
    content: `Withdraw your application for **${found.formName}**? Staff won't review it, and this can't be undone.`,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 4, label: "Yes, withdraw", customId: encodeCustomId("submission", "withdraw_confirm", submissionId) },
        ],
      },
    ],
  } as never);
}

/** "Yes, withdraw": do it. */
export async function handleWithdrawConfirm(bot: AppealyBot, interaction: Interaction, submissionId: string) {
  await defer(bot, interaction, { ephemeral: true });
  const found = await ownPending(interaction, submissionId);
  if ("error" in found) return finish(bot, interaction, found.error);
  const { submission, form } = found;

  // Still pending at the moment of writing: a reviewer may have decided in
  // the seconds between the two clicks.
  const [withdrawn] = await db
    .update(schema.submissions)
    .set({ status: "withdrawn" })
    .where(and(eq(schema.submissions.id, submission.id), eq(schema.submissions.status, "pending")))
    .returning({ id: schema.submissions.id });
  if (!withdrawn) return finish(bot, interaction, "Staff already decided on this application, so it can't be withdrawn.");

  await recordSubmissionEvent({
    guildId: submission.guildId,
    submissionId: submission.id,
    actorId: submission.applicantId,
    action: "withdrawn",
    detail: { by: "applicant" },
  });

  // The review post: no more Accept/Deny, and say why.
  if (submission.logMessageId) {
    await markReviewPost(bot, form.logChannelId, submission.logMessageId, submission.id, {
      color: WITHDRAWN_COLOR,
      footer: `Withdrawn by the applicant • Submission ID: ${submission.id}`,
    });
  }

  if (form.autoArchiveOnDecision && submission.threadId) {
    try {
      await bot.helpers.editChannel(submission.threadId, { archived: true, locked: true });
    } catch (err) {
      logger.warn("Failed to archive staff thread after withdraw", { submissionId, error: String(err) });
    }
  }

  return finish(bot, interaction, `Your application for **${form.name}** was withdrawn.`);
}

/**
 * The clicker's own, still-pending submission. Anyone can click a button
 * they can see; only the applicant may withdraw.
 */
type Submission = typeof schema.submissions.$inferSelect;
type Form = typeof schema.forms.$inferSelect;
type Found = { error: string } | { submission: Submission; form: Form; formName: string };

async function ownPending(interaction: Interaction, submissionId: string): Promise<Found> {
  const clicker = interaction.member?.user?.id ?? interaction.user?.id;
  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, submissionId),
    with: { form: true },
  });
  if (!submission || !clicker || submission.applicantId !== clicker) {
    return { error: "This isn't your application to withdraw." };
  }
  if (submission.status === "withdrawn") return { error: "You already withdrew this application." };
  if (submission.status !== "pending") return { error: "Staff already decided on this application, so it can't be withdrawn." };
  return { submission, form: submission.form, formName: submission.form.name };
}
