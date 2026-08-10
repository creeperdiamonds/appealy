// bot/src/interactions/modals/formSubmit.ts
//
// Final step of the application flow. Called when the user submits the
// Discord modal. Responsibilities:
//   1. Merge modal text answers with any previously-stashed select answers.
//   2. Persist Submission + Answer rows.
//   3. Post a formatted review embed to the form's log channel with
//      Accept/Deny buttons.
//   4. Spawn a staff collaboration thread on that message.
//   5. DM the applicant a submission confirmation using the form's
//      custom template (if configured) or a sane default.

import { eq } from "drizzle-orm";
import type { Interaction } from "@discordeno/bot";
import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import {
  encodeCustomId,
  interpolateTemplate,
} from "../../../../shared/types/index.ts";
import {
  getPendingSelectAnswers,
  clearPendingSelectAnswers,
  getApplicationStartedAt,
} from "../../services/pendingAnswers.ts";
import { sendTemplatedDm } from "../../services/dmService.ts";
import { checkAndConsumeDailyCap, rateLimitDeniedMessage } from "../../services/rateLimitService.ts";
import { findUnmanageableRoles } from "../../services/permissionService.ts";
import { validateAnswerAgainstPattern } from "../../../../shared/schema/regexValidation.ts";
import { logger } from "../../utils/logger.ts";

const EPHEMERAL = 64;

export async function handleFormModalSubmit(
  bot: AppealyBot,
  interaction: Interaction,
  formId: string,
) {
  const guildId = interaction.guildId;
  const applicant = interaction.member?.user ?? interaction.user;
  if (!guildId || !applicant) return;

  const form = await db.query.forms.findFirst({
    where: eq(schema.forms.id, formId),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });
  if (!form) {
    return respond(bot, interaction, "This form no longer exists.");
  }

  const rateLimit = await checkAndConsumeDailyCap(guildId, "submissionsPerDay");
  if (!rateLimit.allowed) {
    return respond(bot, interaction, rateLimitDeniedMessage(rateLimit, "applications processed today"));
  }

  // Collect text-input answers from the modal's action rows.
  const textAnswers: Record<string, string> = {};
  for (const row of interaction.data?.components ?? []) {
    for (const comp of row.components ?? []) {
      if (comp.customId && typeof comp.value === "string") {
        textAnswers[comp.customId] = comp.value;
      }
    }
  }

  const selectAnswers = await getPendingSelectAnswers(applicant.id, formId);
  const allAnswers = { ...selectAnswers, ...textAnswers };

  const validationFailure = validateAnswersAgainstQuestions(form.questions, allAnswers);
  if (validationFailure) {
    return respond(bot, interaction, validationFailure);
  }

  const startedAt = await getApplicationStartedAt(applicant.id, formId);
  const completionSeconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;

  // Insert submission + answers transactionally.
  const submission = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.submissions)
      .values({
        formId: form.id,
        guildId,
        applicantId: applicant.id,
        status: "pending",
        completionSeconds,
      })
      .returning();

    const answerRows = form.questions
      .filter((q) => allAnswers[q.id] !== undefined && allAnswers[q.id] !== "")
      .map((q) => ({
        submissionId: created.id,
        questionId: q.id,
        value: allAnswers[q.id],
      }));

    if (answerRows.length > 0) {
      await tx.insert(schema.answers).values(answerRows);
    }

    return created;
  });

  await clearPendingSelectAnswers(applicant.id, formId);

  // Acknowledge to the applicant immediately.
  await respond(bot, interaction, `Your application for **${form.name}** has been submitted!`);

  await applyRoleAutomationOnSubmit(bot, guildId, form, applicant.id, submission.id);
  await postReviewEmbedForSubmission(bot, form, submission, applicant.id, allAnswers, completionSeconds);
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}

export async function applyRoleAutomationOnSubmit(
  bot: AppealyBot,
  guildId: bigint,
  form: typeof schema.forms.$inferSelect,
  applicantId: bigint,
  submissionId: string,
) {
  // Roles stripped the instant a submission is created, regardless of
  // eventual outcome (e.g. a "Can Apply" role that shouldn't allow a
  // second attempt even before staff have reviewed the first).
  if (form.removeRolesOnSubmitIds.length > 0) {
    const unmanageable = await findUnmanageableRoles(bot, guildId, form.removeRolesOnSubmitIds);
    const manageable = form.removeRolesOnSubmitIds.filter((r) => !unmanageable.includes(r));
    try {
      for (const roleId of manageable) {
        await bot.helpers.removeRole(guildId, applicantId, BigInt(roleId), "Application submitted");
      }
    } catch (err) {
      logger.error("Failed to remove submit-time roles", { submissionId, error: String(err) });
    }
  }

  // Roles granted while the submission is pending review — removed
  // automatically once accepted/denied (see reviewAccept.ts / denyReason.ts).
  if (form.pendingRoleIds.length > 0) {
    const unmanageable = await findUnmanageableRoles(bot, guildId, form.pendingRoleIds);
    const manageable = form.pendingRoleIds.filter((r) => !unmanageable.includes(r));
    try {
      for (const roleId of manageable) {
        await bot.helpers.addRole(guildId, applicantId, BigInt(roleId), "Application pending review");
      }
    } catch (err) {
      logger.error("Failed to grant pending roles", { submissionId, error: String(err) });
    }
  }
}

/**
 * Posts the staff-facing review embed, spawns the collaboration thread,
 * and sends the applicant's submission-confirmation DM. Shared by both
 * application types (in_server calls this directly at the end of
 * handleFormModalSubmit; direct_message calls it from
 * dmApplicationService.ts's finalizeDmApplication) so the two flows can
 * never produce different-looking review posts for staff.
 */
export async function postReviewEmbedForSubmission(
  bot: AppealyBot,
  form: typeof schema.forms.$inferSelect & { questions: (typeof schema.questions.$inferSelect)[] },
  submission: typeof schema.submissions.$inferSelect,
  applicantId: bigint,
  answers?: Record<string, string>,
  completionSecondsOverride?: number | null,
) {
  const guildId = submission.guildId;
  const completionSeconds = completionSecondsOverride ?? submission.completionSeconds;

  // For the DM flow, answers aren't passed in-memory the same way — load
  // them back from the DB rows just inserted, so this function works
  // identically regardless of caller.
  const resolvedAnswers =
    answers ??
    Object.fromEntries(
      (
        await db.query.answers.findMany({ where: eq(schema.answers.submissionId, submission.id) })
      ).map((a) => [a.questionId, a.value]),
    );

  const fields = form.hideAnswersInEmbed
    ? [
        { name: "Answers", value: "Hidden — view on the dashboard.", inline: false },
        ...(completionSeconds !== null && completionSeconds !== undefined
          ? [{ name: "Completion time", value: formatDuration(completionSeconds), inline: true }]
          : []),
      ]
    : [
        ...form.questions
          .filter((q) => resolvedAnswers[q.id])
          .map((q) => ({
            name: q.label.slice(0, 256),
            value: resolvedAnswers[q.id].slice(0, 1024) || "—",
            inline: false,
          })),
        ...(completionSeconds !== null && completionSeconds !== undefined
          ? [{ name: "Completion time", value: formatDuration(completionSeconds), inline: true }]
          : []),
      ];

  const pingContent =
    form.pingRoleIds.length > 0 ? form.pingRoleIds.map((r) => `<@&${r}>`).join(" ") : undefined;

  let logMessage;
  try {
    logMessage = await bot.helpers.sendMessage(form.logChannelId, {
      content: pingContent,
      allowedMentions: { roles: form.pingRoleIds.map((r) => BigInt(r)) },
      embeds: [
        {
          title: `New Application — ${form.name}`,
          description: `Submitted by <@${applicantId}>`,
          color: 0x5865f2,
          fields,
          footer: { text: `Submission ID: ${submission.id}` },
          timestamp: new Date().toISOString(),
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "Accept",
              customId: encodeCustomId("review", "accept", submission.id),
            },
            {
              type: 2,
              style: 4,
              label: "Deny",
              customId: encodeCustomId("review", "deny", submission.id),
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error("Failed to post review embed", { formId: form.id, submissionId: submission.id, error: String(err) });
    return;
  }

  await db.update(schema.submissions).set({ logMessageId: logMessage.id }).where(eq(schema.submissions.id, submission.id));

  if (form.threadCollabEnabled) {
    try {
      const applicantUser = await bot.helpers.getUser(applicantId).catch(() => null);
      const threadName = (form.threadName ?? "Review: {username}")
        .replace("{username}", applicantUser?.username ?? applicantId.toString())
        .slice(0, 100);

      const thread = await bot.helpers.startThreadWithMessage(form.logChannelId, logMessage.id, {
        name: threadName,
        autoArchiveDuration: 1440,
      });

      await db.update(schema.submissions).set({ threadId: thread.id }).where(eq(schema.submissions.id, submission.id));

      await bot.helpers.sendMessage(thread.id, {
        content: `Staff discussion thread for <@${applicantId}>'s application. Use the Accept/Deny buttons on the original post to record a decision.`,
      });
    } catch (err) {
      logger.error("Failed to spawn staff thread", { submissionId: submission.id, error: String(err) });
    }
  }

  const applicantUser = await bot.helpers.getUser(applicantId).catch(() => null);
  await sendTemplatedDm(bot, {
    formId: form.id,
    type: "submission",
    userId: applicantId,
    username: applicantUser?.username ?? "there",
    userTag: applicantUser ? `${applicantUser.username}#${applicantUser.discriminator ?? "0"}` : applicantId.toString(),
    guildName: (await bot.cache?.guilds?.get(guildId))?.name ?? "the server",
    formName: form.name,
  });
}

/**
 * Checks every regex-validated question's answer against its pattern.
 * Returns a user-facing error string for the FIRST failing question (not
 * a combined list — Discord's ephemeral response is a single message, and
 * pointing at one concrete problem at a time is clearer than a wall of
 * errors), or null if everything passes. Exported so the DM application
 * flow (dmApplicationService.ts) can run the identical check per-answer
 * as it collects them one at a time, rather than only at final submit.
 */
export function validateAnswersAgainstQuestions(
  questions: (typeof schema.questions.$inferSelect)[],
  answers: Record<string, string>,
): string | null {
  for (const q of questions) {
    if (q.validationType !== "regex" || !q.validationPattern) continue;
    const answer = answers[q.id];
    if (answer === undefined || answer === "") continue; // optional-and-blank is handled by `required`, not here

    const result = validateAnswerAgainstPattern(answer, q.validationPattern);
    if (!result.valid) {
      return q.validationErrorMessage ?? `Your answer to "${q.label}" doesn't match the required format. Please try again.`;
    }
  }
  return null;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
