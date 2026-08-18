// bot/src/services/dmApplicationService.ts
//
// direct_message application type: instead of a Discord Modal (which can
// only be shown as a response to a guild interaction, not usable in a pure
// DM context the way this needs to work), the bot DMs the applicant one
// question at a time and collects plain-message replies. Progress is
// tracked in dm_application_progress so the flow survives the bot
// restarting mid-conversation.
//
// This is intentionally message-based rather than component-based (no
// buttons/selects driving it) because a DM conversation is the one place
// in this codebase where "wait for the user's next message" is the
// natural interaction model — matching how a human would conduct the same
// back-and-forth manually.

import { eq, and, desc } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { countRows } from "../db/count.ts";
import { evaluateGate, gateReasonToMessage } from "../../../shared/schema/gating.ts";
import { validateAnswerAgainstPattern } from "../../../shared/schema/regexValidation.ts";
import { checkAndConsumeDailyCap, rateLimitDeniedMessage } from "./rateLimitService.ts";
import { logger } from "../utils/logger.ts";

type FormWithQuestions = typeof schema.forms.$inferSelect & {
  questions: (typeof schema.questions.$inferSelect)[];
};

export async function startDmApplication(
  bot: AppealyBot,
  guildId: bigint,
  form: FormWithQuestions,
  applicantId: bigint,
  memberRoleIds: bigint[],
  // Extra line sent as its own DM before the confirmation — used by the
  // ban-appeal flow to explain why someone just banned is getting an
  // unsolicited DM. Ordinary DM applications never need this.
  introNote?: string,
) {
  const gate = await checkGateForDm(form, guildId, applicantId, memberRoleIds);
  if (!gate.allowed) {
    return dmOrLog(bot, applicantId, gateReasonToMessage(gate));
  }

  const existing = await db.query.dmApplicationProgress.findFirst({
    where: and(eq(schema.dmApplicationProgress.formId, form.id), eq(schema.dmApplicationProgress.applicantId, applicantId)),
  });
  if (existing) {
    return dmOrLog(bot, applicantId, "You already have an application in progress. Reply to my last message to continue, or wait for it to expire.");
  }

  const expiresAt = form.timeLimitSeconds ? new Date(Date.now() + form.timeLimitSeconds * 1000) : null;

  await db.insert(schema.dmApplicationProgress).values({
    formId: form.id,
    applicantId,
    guildId,
    currentQuestionIndex: 0,
    answers: {},
    expiresAt,
  });

  if (introNote) {
    const introSent = await dmOrLog(bot, applicantId, introNote);
    if (!introSent) {
      // DMs closed — drop the progress row so it doesn't sit forever as an
      // unreachable "in progress" state the applicant can never clear.
      await db.delete(schema.dmApplicationProgress).where(
        and(eq(schema.dmApplicationProgress.formId, form.id), eq(schema.dmApplicationProgress.applicantId, applicantId)),
      );
      return;
    }
  }

  const confirmation = form.confirmationMessage
    ? `${form.confirmationMessage}\n\nI'll send you ${form.questions.length} question(s) one at a time. Just reply with your answer to each.`
    : `I'll send you ${form.questions.length} question(s) one at a time. Just reply with your answer to each.`;

  const sent = await dmOrLog(bot, applicantId, confirmation);
  if (!sent) {
    // Same cleanup as the introNote path. This branch existed in the older
    // tree and was lost in the scaled one, leaving orphan progress rows that
    // permanently blocked the applicant from restarting.
    await db.delete(schema.dmApplicationProgress).where(
      and(eq(schema.dmApplicationProgress.formId, form.id), eq(schema.dmApplicationProgress.applicantId, applicantId)),
    );
    return;
  }

  await sendNextQuestion(bot, form, applicantId);
}

/** Called from a messageCreate handler (bot/src/events/messageCreate.ts)
 * whenever a DM arrives from a user with an in-progress application. */
export async function handleDmApplicationReply(bot: AppealyBot, userId: bigint, content: string) {
  const progress = await db.query.dmApplicationProgress.findFirst({
    where: eq(schema.dmApplicationProgress.applicantId, userId),
  });
  if (!progress) return false; // not mid-application — let other handlers process this DM

  if (progress.expiresAt && progress.expiresAt < new Date()) {
    await db.delete(schema.dmApplicationProgress).where(eq(schema.dmApplicationProgress.id, progress.id));
    await dmOrLog(bot, userId, "Your application session has expired. Please start again.");
    return true;
  }

  const form = await db.query.forms.findFirst({
    where: eq(schema.forms.id, progress.formId),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });
  if (!form || !form.active) {
    await db.delete(schema.dmApplicationProgress).where(eq(schema.dmApplicationProgress.id, progress.id));
    await dmOrLog(bot, userId, "This application is no longer available.");
    return true;
  }

  const currentQuestion = form.questions[progress.currentQuestionIndex];
  if (!currentQuestion) {
    // Shouldn't happen, but fail safe rather than crash the message handler.
    await db.delete(schema.dmApplicationProgress).where(eq(schema.dmApplicationProgress.id, progress.id));
    return true;
  }

  if (currentQuestion.required && content.trim().length === 0) {
    await dmOrLog(bot, userId, "This question is required — please provide an answer.");
    return true;
  }
  if (currentQuestion.maxLength && content.length > currentQuestion.maxLength) {
    await dmOrLog(bot, userId, `Your answer is too long (max ${currentQuestion.maxLength} characters). Please try again.`);
    return true;
  }
  if (currentQuestion.minLength && content.length < currentQuestion.minLength) {
    await dmOrLog(bot, userId, `Your answer is too short (min ${currentQuestion.minLength} characters). Please try again.`);
    return true;
  }
  if (currentQuestion.validationType === "regex" && currentQuestion.validationPattern && content.trim().length > 0) {
    const result = validateAnswerAgainstPattern(content, currentQuestion.validationPattern);
    if (!result.valid) {
      await dmOrLog(
        bot,
        userId,
        currentQuestion.validationErrorMessage ?? `That doesn't match the required format for this question. Please try again.`,
      );
      return true;
    }
  }

  const updatedAnswers = { ...progress.answers, [currentQuestion.id]: content };
  const nextIndex = progress.currentQuestionIndex + 1;

  if (nextIndex >= form.questions.length) {
    // Final answer received — finalize into a real submission.
    await finalizeDmApplication(bot, form, progress, updatedAnswers);
  } else {
    await db
      .update(schema.dmApplicationProgress)
      .set({ currentQuestionIndex: nextIndex, answers: updatedAnswers })
      .where(eq(schema.dmApplicationProgress.id, progress.id));
    await sendNextQuestion(bot, form, userId, nextIndex);
  }

  return true;
}

async function sendNextQuestion(bot: AppealyBot, form: FormWithQuestions, userId: bigint, index = 0) {
  const question = form.questions[index];
  if (!question) return;
  const requiredNote = question.required ? "" : " (optional — reply with a single space to skip)";
  await dmOrLog(bot, userId, `**${form.name}** — Question ${index + 1}/${form.questions.length}\n${question.label}${requiredNote}`);
}

async function finalizeDmApplication(
  bot: AppealyBot,
  form: FormWithQuestions,
  progress: typeof schema.dmApplicationProgress.$inferSelect,
  finalAnswers: Record<string, string>,
) {
  const rateLimit = await checkAndConsumeDailyCap(progress.guildId, "submissionsPerDay");
  if (!rateLimit.allowed) {
    await db.delete(schema.dmApplicationProgress).where(eq(schema.dmApplicationProgress.id, progress.id));
    await dmOrLog(bot, progress.applicantId, rateLimitDeniedMessage(rateLimit, "applications processed today"));
    return;
  }

  const completionSeconds = Math.round((Date.now() - progress.startedAt.getTime()) / 1000);

  const submission = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.submissions)
      .values({
        formId: form.id,
        guildId: progress.guildId,
        applicantId: progress.applicantId,
        status: "pending",
        completionSeconds,
      })
      .returning();

    const answerRows = form.questions
      .filter((q) => finalAnswers[q.id] !== undefined && finalAnswers[q.id].trim() !== "")
      .map((q) => ({ submissionId: created.id, questionId: q.id, value: finalAnswers[q.id] }));

    if (answerRows.length > 0) {
      await tx.insert(schema.answers).values(answerRows);
    }
    return created;
  });

  await db.delete(schema.dmApplicationProgress).where(eq(schema.dmApplicationProgress.id, progress.id));

  await dmOrLog(bot, progress.applicantId, `Your application for **${form.name}** has been submitted!`);

  const { applyRoleAutomationOnSubmit, postReviewEmbedForSubmission } = await import("../interactions/modals/formSubmit.ts");
  await applyRoleAutomationOnSubmit(bot, progress.guildId, form, progress.applicantId, submission.id);
  await postReviewEmbedForSubmission(bot, form, submission, progress.applicantId, finalAnswers, completionSeconds);

  logger.info("DM application finalized", { formId: form.id, submissionId: submission.id });
}

async function checkGateForDm(
  form: FormWithQuestions,
  guildId: bigint,
  applicantId: bigint,
  memberRoleIds: bigint[],
) {
  const [lastSubmission] = await db
    .select()
    .from(schema.submissions)
    .where(and(eq(schema.submissions.formId, form.id), eq(schema.submissions.applicantId, applicantId)))
    .orderBy(desc(schema.submissions.createdAt))
    .limit(1);

  const pendingCount = await countRows(
    schema.submissions,
    and(eq(schema.submissions.formId, form.id), eq(schema.submissions.applicantId, applicantId), eq(schema.submissions.status, "pending")),
  );
  const totalCount = await countRows(
    schema.submissions,
    and(eq(schema.submissions.formId, form.id), eq(schema.submissions.applicantId, applicantId)),
  );

  const override = await db.query.gateOverrides.findFirst({
    where: and(eq(schema.gateOverrides.formId, form.id), eq(schema.gateOverrides.applicantId, applicantId)),
  });
  const hasActiveOverride = Boolean(override && (!override.expiresAt || override.expiresAt > new Date()));

  return evaluateGate({
    formActive: form.active,
    memberRoleIds: memberRoleIds.map(String),
    requiredRoleIds: form.requiredRoleIds,
    requiredRolesMatchMode: form.requiredRolesMatchMode,
    blacklistedRoleIds: form.blacklistedRoleIds,
    blacklistedRolesMatchMode: form.blacklistedRolesMatchMode,
    cooldownSeconds: form.cooldownSeconds,
    lastSubmissionAt: lastSubmission?.createdAt ?? null,
    hasPendingSubmission: pendingCount > 0,
    allowMultiplePending: form.allowMultiplePending,
    totalSubmissionCount: totalCount,
    maxTotalSubmissions: form.maxTotalSubmissions,
    submissionsInWindow: 0,
    maxSubmissionsInWindow: form.maxSubmissionsInWindow,
    hasActiveOverride,
  });
}

async function dmOrLog(bot: AppealyBot, userId: bigint, content: string): Promise<boolean> {
  try {
    const dmChannel = await bot.helpers.getDmChannel(userId);
    await bot.helpers.sendMessage(dmChannel.id, { content });
    return true;
  } catch (err) {
    logger.warn("Failed to DM applicant during DM application flow", { userId: userId.toString(), error: String(err) });
    return false;
  }
}
