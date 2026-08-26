// bot/src/interactions/selects/formSelectStep.ts
//
// Handles a select-menu answer during the pre-modal step (see
// interactions/buttons/panelOpen.ts). Advances to the next select
// question if any remain, otherwise shows the final text-input modal.

import { eq } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { encodeCustomId } from "../../../../shared/types/index.ts";
import { stashPendingSelectAnswers } from "../../services/pendingAnswers.ts";
import { showApplicationModal } from "../buttons/panelOpen.ts";

const EPHEMERAL = 64;

// Deliberately does NOT defer, unlike its siblings in this directory.
// When no select questions remain, this handler's response IS a modal
// (showApplicationModal(), called at the bottom of this function and
// defined in ../buttons/panelOpen.ts, is where the literal `type: 9` MODAL
// response lives) — Discord requires a modal to be an interaction's FIRST
// response, and a deferred interaction can never open one. See
// bot/src/utils/interactionResponse.ts's top comment and this file's entry
// in deferGuard.test.ts's MUST_NOT_DEFER list.
//
// Consequence: the lookups above (stashPendingSelectAnswers, the forms
// query) have to stay fast enough to answer within Discord's three-second
// window on their own — this handler has no deferral to fall back on to
// buy time if they ever aren't. Keep them cache-backed / index-backed
// rather than letting slower work creep in front of the response.
export async function handleFormSelectStep(
  bot: AppealyBot,
  interaction: Interaction,
  formId: string,
  questionId: string | undefined,
) {
  const applicant = interaction.member?.user ?? interaction.user;
  if (!applicant || !questionId) return;

  const chosenValue = interaction.data?.values?.[0] ?? "";
  await stashPendingSelectAnswers(applicant.id, formId, questionId, chosenValue);

  const form = await db.query.forms.findFirst({
    where: eq(schema.forms.id, formId),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });
  if (!form) return;

  const selectQuestions = form.questions.filter((q) => q.type === "select");
  const currentIndex = selectQuestions.findIndex((q) => q.id === questionId);
  const next = selectQuestions[currentIndex + 1];

  if (next) {
    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 7, // UPDATE_MESSAGE
      data: {
        content: `**${form.name}** — ${next.label}${next.required ? "" : " (optional)"}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 3,
                customId: encodeCustomId("modal", "select", formId, next.id),
                placeholder: next.placeholder ?? "Choose an option",
                minValues: next.required ? 1 : 0,
                maxValues: 1,
                options: (next.options ?? []).map((o) => ({
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

  // All select questions answered — show the modal for remaining text
  // questions. Note: showing a MODAL is only valid as a *direct* response
  // to this interaction (type 9), which is why this must be the response
  // to the select interaction itself rather than a follow-up.
  const textQuestions = form.questions.filter((q) => q.type !== "select");
  await showApplicationModal(bot, interaction, formId, textQuestions);
}
