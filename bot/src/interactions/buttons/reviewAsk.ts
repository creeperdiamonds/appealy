// bot/src/interactions/buttons/reviewAsk.ts
//
// The two buttons of a follow-up question that open a modal:
//
//   "Ask applicant", on the review post  → staff type a question
//   "Answer", on the DM the applicant got → they type their answer
//
// A modal must be the FIRST response to the click, so neither handler may
// defer or touch the network first (see utils/interactionResponse.ts and
// deferGuard.test.ts). Who may ask, and whose question it is, are checked
// when the modal is submitted instead: interactions/modals/followUp.ts.

import { encodeCustomId } from "../../../../shared/types/index.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import type { AppealyBot } from "../../core/client.ts";

/** Discord's limits: a text input's value, and its label. */
const QUESTION_MAX = 1000;
const ANSWER_MAX = 2000;

export async function openAskModal(bot: AppealyBot, interaction: Interaction, submissionId: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9, // MODAL
    data: {
      customId: encodeCustomId("review", "ask_submit", submissionId),
      title: "Ask the applicant",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // TEXT_INPUT
              customId: "question",
              label: "Your question",
              style: 2, // paragraph
              required: true,
              minLength: 2,
              maxLength: QUESTION_MAX,
              placeholder: "They'll get it in a DM and can answer from there.",
            },
          ],
        },
      ],
    },
  });
}

export async function openAnswerModal(bot: AppealyBot, interaction: Interaction, followupId: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9, // MODAL
    data: {
      customId: encodeCustomId("submission", "answer_submit", followupId),
      title: "Answer the staff",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // TEXT_INPUT
              customId: "answer",
              label: "Your answer",
              style: 2, // paragraph
              required: true,
              minLength: 1,
              maxLength: ANSWER_MAX,
            },
          ],
        },
      ],
    },
  });
}
