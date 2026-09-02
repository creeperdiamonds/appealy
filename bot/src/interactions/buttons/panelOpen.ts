// bot/src/interactions/buttons/panelOpen.ts
//
// Fires when a user clicks an "Apply" button on a published panel.
// Responsibilities:
//   1. Run the gating engine (role gate, cooldown, submission limits).
//   2. If gated out, respond ephemerally with the reason.
//   3. Otherwise show a Discord Modal built from the form's questions.
//
// Discord modals only support text inputs (short/paragraph) natively —
// there is no native "select" component inside a modal as of the current
// Discord API. Forms that include a `select` question therefore route
// through a two-step flow: an ephemeral message with a select menu first
// (handled in interactions/selects/), whose choice is stashed in Redis,
// then the modal is shown for the remaining text questions on select
// interaction. See docs/ARCHITECTURE.md#select-questions for the full
// state diagram.

import { eq, and, gte, desc } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { countRows } from "../../db/count.ts";
import { evaluateGate, gateReasonToMessage } from "../../../../shared/schema/gating.ts";
import { encodeCustomId } from "../../../../shared/types/index.ts";
import {
  cappedModalPageCount,
  modalPageSlice,
  MAX_MODAL_PAGES,
  MODAL_PAGE_SIZE,
} from "../../../../shared/lib/modalPaging.ts";
import { logger } from "../../utils/logger.ts";
import { stashPendingSelectAnswers, markApplicationStarted } from "../../services/pendingAnswers.ts";

const EPHEMERAL = 64;

/** Entry point shared by the panel "Apply" button and the /apply slash
 * command, so gating + modal-building behavior can never drift between
 * the two ways a user can start an application. */
export async function handlePanelOpenButton(
  bot: AppealyBot,
  interaction: Interaction,
  formId: string,
) {
  return runApplicationFlow(bot, interaction, formId);
}

export async function runApplicationFlow(
  bot: AppealyBot,
  interaction: Interaction,
  formId: string,
  // /apply (commands/apply.ts) already looks this exact row up — with its
  // questions, since it needs to validate the name before it can call in —
  // to resolve the option text to a form. Without this parameter that
  // lookup would happen a second time here, and /apply can't afford it:
  // it opens a modal, so it can never defer, and everything before the
  // modal has to fit inside Discord's three-second window with no way to
  // buy more. handlePanelOpenButton has no form in hand (only the button's
  // formId), so this stays optional and this function still fetches when
  // it isn't supplied.
  prefetchedForm?: typeof schema.forms.$inferSelect & {
    questions: (typeof schema.questions.$inferSelect)[];
  },
) {
  const guildId = interaction.guildId;
  const applicant = interaction.member?.user ?? interaction.user;
  if (!guildId || !applicant) return;

  const form =
    prefetchedForm ??
    (await db.query.forms.findFirst({
      where: eq(schema.forms.id, formId),
      with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
    }));

  if (!form || !form.active) {
    return respond(bot, interaction, "This form is no longer available.");
  }

  if (form.applicationType === "direct_message") {
    const { startDmApplication } = await import("../../services/dmApplicationService.ts");
    return startDmApplication(bot, guildId, form, applicant.id, interaction.member?.roles ?? []);
  }

  const gate = await checkGate(form, guildId, applicant.id, interaction.member?.roles ?? []);
  if (!gate.allowed) {
    return respond(bot, interaction, gateReasonToMessage(gate));
  }

  // Confirmation step: Discord modals can't carry a body/description of
  // their own, so the confirmation message is shown as its own ephemeral
  // reply with a "Continue" button; clicking that button is what actually
  // triggers showApplicationModal, since a MODAL response is only valid as
  // the direct response to *that* interaction (see the encodeCustomId
  // "modal:confirm" handler in events/interactionCreate.ts).
  if (form.confirmationMessage) {
    return await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: EPHEMERAL,
        content: form.confirmationMessage,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Continue",
                customId: encodeCustomId("modal", "confirm", formId),
              },
            ],
          },
        ],
      },
    });
  }

  await proceedToQuestions(bot, interaction, formId, form);
}

export async function proceedToQuestions(
  bot: AppealyBot,
  interaction: Interaction,
  formId: string,
  form: typeof schema.forms.$inferSelect & { questions: (typeof schema.questions.$inferSelect)[] },
) {
  const textQuestions = form.questions.filter((q) => q.type !== "select");
  const selectQuestions = form.questions.filter((q) => q.type === "select");

  // If there are select-type questions, present those first via a select
  // menu message; the modal for text questions is shown once selections
  // are made (see interactions/selects/formSelectStep.ts).
  if (selectQuestions.length > 0) {
    const firstSelect = selectQuestions[0];
    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: EPHEMERAL,
        content: `**${form.name}** — ${firstSelect.label}${firstSelect.required ? "" : " (optional)"}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 3, // string select
                customId: encodeCustomId("modal", "select", formId, firstSelect.id),
                placeholder: firstSelect.placeholder ?? "Choose an option",
                minValues: firstSelect.required ? 1 : 0,
                maxValues: 1,
                options: (firstSelect.options ?? []).map((o) => ({
                  label: o.label,
                  value: o.value,
                  description: o.description,
                })),
              },
            ],
          },
        ],
      },
    });
    return;
  }

  await showApplicationModal(bot, interaction, formId, textQuestions);
}

export async function showApplicationModal(
  bot: AppealyBot,
  interaction: Interaction,
  formId: string,
  textQuestions: (typeof schema.questions.$inferSelect)[],
  page = 0,
) {
  const applicant = interaction.member?.user ?? interaction.user;
  // Only on the first page. completionSeconds measures how long the applicant
  // took overall, so restarting the clock on page two would report the last
  // page's duration as the whole application's.
  if (applicant && page === 0) {
    await markApplicationStarted(applicant.id, formId);
  }

  const totalPages = cappedModalPageCount(textQuestions.length);
  const capped = modalPageSlice(textQuestions, page);

  if (textQuestions.length > MODAL_PAGE_SIZE * MAX_MODAL_PAGES) {
    // Still a truncation, but a bounded and reported one rather than a silent
    // one at five. Worth surfacing because it means the form is misconfigured.
    logger.warn("Form exceeds the modal page ceiling; questions beyond it are not asked", {
      formId,
      total: textQuestions.length,
      asked: MODAL_PAGE_SIZE * MAX_MODAL_PAGES,
    });
  }

  // Discord's modal text-input label has a hard 45-character limit —
  // this is the in_server-flow constraint the schema comment on
  // questions.label refers to. The DB column now allows up to 200 chars
  // (raised specifically so direct_message-flow questions aren't
  // needlessly constrained by a limit that flow doesn't have), so this
  // flow truncates at render time rather than the schema enforcing the
  // tighter limit for both flows. Truncating (with an ellipsis) rather
  // than letting Discord reject the whole modal outright preserves the
  // rest of the application working even if one label is long.
  const MODAL_LABEL_MAX = 45;
  const toModalLabel = (label: string) =>
    label.length > MODAL_LABEL_MAX ? `${label.slice(0, MODAL_LABEL_MAX - 1)}…` : label;

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9, // MODAL
    data: {
      // The page rides in the custom id so the submit handler knows whether
      // this is the last one without re-deriving it from a stash that may
      // have expired.
      customId: encodeCustomId("modal", "submit", formId, String(page)),
      title: totalPages > 1 ? `Application (${page + 1}/${totalPages})` : "Application",
      components: capped.map((q) => ({
        type: 1,
        components: [
          {
            type: 4, // TEXT_INPUT
            customId: q.id,
            label: toModalLabel(q.label),
            style: q.type === "paragraph" ? 2 : 1,
            required: q.required,
            minLength: q.minLength ?? undefined,
            maxLength: q.maxLength ?? 4000,
            placeholder: q.placeholder ?? undefined,
          },
        ],
      })),
    },
  });
}

async function checkGate(
  form: typeof schema.forms.$inferSelect,
  guildId: bigint,
  applicantId: bigint,
  memberRoleIds: bigint[],
) {
  // These five reads are independent — each depends only on form/guildId/
  // applicantId, all already in hand, and none consumes another's result —
  // so they were only ever sequential because that's how this was written.
  // That's cheap to ignore when everything's warm (five trips at ~5ms is
  // noise), but this runs on the /apply and panel-button paths, neither of
  // which can defer: they end in a modal, and a modal response has to be
  // Discord's FIRST response, so there is no fifteen-minute window to fall
  // back on if things are slow. Cold or degraded, five sequential ~100ms
  // round trips is 500ms out of the 3000ms budget — the exact case
  // parallelising this actually protects against.
  const [[lastSubmission], pendingCount, totalCount, windowCount, override] = await Promise.all([
    db
      .select()
      .from(schema.submissions)
      .where(
        and(
          eq(schema.submissions.formId, form.id),
          eq(schema.submissions.applicantId, applicantId),
        ),
      )
      .orderBy(desc(schema.submissions.createdAt))
      .limit(1),
    countRows(
      schema.submissions,
      and(
        eq(schema.submissions.formId, form.id),
        eq(schema.submissions.applicantId, applicantId),
        eq(schema.submissions.status, "pending"),
      ),
    ),
    countRows(
      schema.submissions,
      and(eq(schema.submissions.formId, form.id), eq(schema.submissions.applicantId, applicantId)),
    ),
    form.maxSubmissionsWindowSeconds && form.maxSubmissionsInWindow
      ? countRows(
          schema.submissions,
          and(
            eq(schema.submissions.formId, form.id),
            gte(
              schema.submissions.createdAt,
              new Date(Date.now() - form.maxSubmissionsWindowSeconds * 1000),
            ),
          ),
        )
      : Promise.resolve(0),
    db.query.gateOverrides.findFirst({
      where: and(eq(schema.gateOverrides.formId, form.id), eq(schema.gateOverrides.applicantId, applicantId)),
    }),
  ]);
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
    submissionsInWindow: windowCount,
    maxSubmissionsInWindow: form.maxSubmissionsInWindow,
    hasActiveOverride,
  });
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
