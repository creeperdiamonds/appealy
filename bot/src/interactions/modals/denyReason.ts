// bot/src/interactions/modals/denyReason.ts

import { confirmationWithAsk } from "../../services/feedbackAsk.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import type { AppealyBot } from "../../core/client.ts";
import { denySubmission, reviewerFromInteraction } from "../../services/reviewDecision.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleDenyReasonModalSubmit(
  bot: AppealyBot,
  interaction: Interaction,
  submissionId: string,
  /** The denial outcome chosen from the menu, when the form has them. */
  outcomeId?: string,
) {
  const guildId = interaction.guildId;
  const reviewer = interaction.member?.user ?? interaction.user;
  if (!guildId || !reviewer) return;

  // A submission lookup, then (usually) several role REST calls, a DB
  // update, a log-message edit, an optional second channel post, and a DM —
  // easily past three seconds. Same shape as reviewAccept.ts's deferral.
  await defer(bot, interaction, { ephemeral: true });

  const reason =
    interaction.data?.components?.[0]?.components?.[0]?.value?.trim() ?? "";

  // The modal's custom id carries the denial outcome picked from the menu,
  // if there was one. It used to be dropped here, so a denial outcome's label
  // and roles never applied.
  const result = await denySubmission(bot, {
    guildId,
    submissionId,
    reviewer: reviewerFromInteraction(reviewer, interaction.member),
    reason,
    outcomeId,
    clicked: interaction.message,
  });
  if (!result.ok) return respond(bot, interaction, result.message);

  // The feedback ask rides on this private confirmation, once per person
  // (services/feedbackAsk.ts).
  await finish(bot, interaction, await confirmationWithAsk(guildId, reviewer.id, result.message));
}

// Kept as a one-line wrapper rather than rewriting every call site: the
// ephemeral flag now lives on the deferral, so there is nothing left for
// this to decide.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
