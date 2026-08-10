// bot/src/interactions/buttons/reviewDeny.ts
//
// Deny is a two-step flow: clicking "Deny" opens a short modal asking for
// an optional reason, since denial reasons are commonly relayed to the
// applicant via DM and staff want the chance to write one without a
// separate command.

import { eq } from "drizzle-orm";
import type { Interaction } from "@discordeno/bot";
import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { canReviewForm } from "../../services/permissionService.ts";
import { encodeCustomId } from "../../../../shared/types/index.ts";

const EPHEMERAL = 64;

export async function handleReviewDeny(
  bot: AppealyBot,
  interaction: Interaction,
  submissionId: string,
) {
  const guildId = interaction.guildId;
  const reviewer = interaction.member?.user ?? interaction.user;
  if (!guildId || !reviewer) return;

  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, submissionId),
  });
  if (!submission) {
    return respond(bot, interaction, "This submission no longer exists.");
  }
  if (submission.status !== "pending") {
    return respond(bot, interaction, `This application was already marked **${submission.status}**.`);
  }

  const allowed = await canReviewForm(
    guildId,
    submission.formId,
    reviewer.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions ?? 0n,
  );
  if (!allowed) {
    return respond(bot, interaction, "You don't have permission to review this application.");
  }

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9, // MODAL
    data: {
      customId: encodeCustomId("review", "deny_confirm", submissionId),
      title: "Deny Application",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              customId: "reason",
              label: "Reason (shown to applicant)",
              style: 2,
              required: false,
              maxLength: 1000,
              placeholder: "Optional — leave blank for no reason given",
            },
          ],
        },
      ],
    },
  });
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
