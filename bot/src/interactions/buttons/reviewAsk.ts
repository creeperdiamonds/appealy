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

/** How many files an answer can carry. */
export const ANSWER_MAX_FILES = 5;

export async function openAnswerModal(bot: AppealyBot, interaction: Interaction, followupId: string) {
  // Text, files, or both: either is an answer, which the submit handler
  // checks (interactions/modals/followUp.ts), since a popup can't require
  // "one of these two".
  try {
    await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 9, // MODAL
      data: {
        customId: encodeCustomId("submission", "answer_submit", followupId),
        title: "Answer the staff",
        components: [
          {
            type: 18, // LABEL
            label: "Your answer",
            component: {
              type: 4, // TEXT_INPUT
              customId: "answer",
              style: 2, // paragraph
              required: false,
              maxLength: ANSWER_MAX,
            },
          },
          {
            type: 18, // LABEL
            label: "Files",
            description: `Optional. Screenshots, videos or documents, up to ${ANSWER_MAX_FILES}.`,
            component: {
              type: 19, // FILE_UPLOAD
              customId: "files",
              required: false,
              minValues: 0,
              maxValues: ANSWER_MAX_FILES,
            },
          },
        ],
      } as never,
    });
  } catch {
    // A refused popup doesn't use up the click, so the text-only one can
    // still open: answering without files beats not being able to answer.
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
}
