// bot/src/interactions/buttons/panelOpen.ts
//
// Fires when a user clicks an "Apply" button on a published panel.
// Responsibilities:
//   1. Run the gating engine (role gate, cooldown, submission limits).
//   2. If gated out, respond ephemerally with the reason.
//   3. Otherwise show a Discord Modal built from the form's questions.
//
// Most forms open as one real popup (services/formPopup.ts): the form's
// description at the top, then every question, dropdowns included.
//
// The older flow below is kept for forms the popup can't hold (more than
// five pages, or a dropdown Discord would refuse). It dates from when popups
// had only text boxes: the description went in a message with a Continue
// button, and each choice question was a dropdown in its own message, stashed
// in Redis, before the popup opened for the text questions.

import { eq, and } from "drizzle-orm";
import { modalTextLimits } from "../../services/modalInput.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { checkApplicationGate } from "../../services/gateCheck.ts";
import { gateReasonToMessage } from "../../../../shared/schema/gating.ts";
import { encodeCustomId } from "../../../../shared/types/index.ts";
import {
  cappedModalPageCount,
  modalPageSlice,
  MAX_MODAL_PAGES,
  MODAL_PAGE_SIZE,
} from "../../../../shared/lib/modalPaging.ts";
import { logger } from "../../utils/logger.ts";
import { stashPendingSelectAnswers, markApplicationStarted } from "../../services/pendingAnswers.ts";
import { buildFormPopup, usesPopupFlow } from "../../services/formPopup.ts";

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
    // Answer the click first, then edit in how it went. This used to answer
    // nothing at all: the applicant saw "This interaction failed" even when
    // the DM arrived, and nothing whatsoever when their DMs were closed.
    // A plain ephemeral reply rather than the defer helper: this file opens
    // modals on other paths (deferGuard.test.ts), and this is just as quick.
    const about = form.description?.trim() ? `**${form.name}**\n${form.description.trim()}\n\n` : "";
    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: { flags: EPHEMERAL, content: `${about}📨 Sending you the questions in DMs…` },
    });
    const { startDmApplication } = await import("../../services/dmApplicationService.ts");
    const outcome = await startDmApplication(bot, guildId, form, applicant.id, interaction.member?.roles ?? []);
    const status =
      outcome.status === "started" ? "📬 Check your DMs: I've sent you the first question."
      : outcome.status === "dm_closed"
        ? "❌ I couldn't DM you. Turn on **Direct Messages** in this server's **Privacy Settings** (open the server menu), then try again."
      : outcome.status === "in_progress" ? "You already have this application open in your DMs. Reply to my last message there to carry on."
      : outcome.message;
    await bot.helpers.editOriginalInteractionResponse(interaction.token, { content: `${about}${status}` }).catch((err) => {
      logger.warn("Couldn't update the DM application status message", { formId, error: String(err) });
    });
    return;
  }

  const gate = await checkApplicationGate(form, applicant.id, interaction.member?.roles ?? []);
  if (!gate.allowed) {
    return respond(bot, interaction, gateReasonToMessage(gate));
  }

  if (usesPopupFlow(form)) {
    try {
      return await showFormPopup(bot, interaction, form, 0);
    } catch (err) {
      // A refused popup isn't an answer, so the click can still be answered
      // the older way below. Without this, a popup Discord didn't accept
      // would leave the applicant with "This interaction failed" and no way in.
      logger.error("Discord refused the application popup; used the older flow instead", {
        formId,
        error: String(err),
      });
    }
  }

  // Confirmation step: Discord modals can't carry a body/description of
  // their own, so the confirmation message is shown as its own ephemeral
  // reply with a "Continue" button; clicking that button is what actually
  // triggers showApplicationModal, since a MODAL response is only valid as
  // the direct response to *that* interaction (see the encodeCustomId
  // "modal:confirm" handler in events/interactionCreate.ts).
  // The form's description is shown here too: a modal has nowhere to put it,
  // and the dashboard tells admins it's shown before the applicant starts.
  const intro = [
    form.description?.trim() ? `**${form.name}**\n${form.description.trim()}` : null,
    form.confirmationMessage?.trim() || null,
  ].filter(Boolean).join("\n\n");
  if (intro) {
    return await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: EPHEMERAL,
        content: intro,
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

/** One page of the form as a real popup (services/formPopup.ts). */
export async function showFormPopup(
  bot: AppealyBot,
  interaction: Interaction,
  form: typeof schema.forms.$inferSelect & { questions: (typeof schema.questions.$inferSelect)[] },
  page: number,
) {
  const applicant = interaction.member?.user ?? interaction.user;
  // Only on the first page, so completionSeconds covers the whole application.
  if (applicant && page === 0) await markApplicationStarted(applicant.id, form.id);
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9, // MODAL
    data: buildFormPopup(form, page) as never,
  });
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

  // A form with no text questions on this page would send a modal with no
  // inputs, which Discord rejects outright. Say so instead.
  if (capped.length === 0) {
    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: EPHEMERAL,
        content: "This form has no questions yet. A server admin can add them on the Appealy dashboard.",
      },
    });
    return;
  }

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
            // Every limit Discord checks is enforced here: one bad setting
            // otherwise rejects the whole modal (services/modalInput.ts).
            ...modalTextLimits(q),
            style: q.type === "paragraph" ? 2 : 1,
            required: q.required,
          },
        ],
      })),
    },
  });
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
