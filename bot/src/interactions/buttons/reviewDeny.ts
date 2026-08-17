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
import { canReviewForm, staffLevelFor } from "../../services/permissionService.ts";
import { encodeCustomId } from "../../../../shared/types/index.ts";
import { buildOutcomeMenu, visibleOutcomes, type FormOutcomeDTO } from "../../../../shared/schema/outcomes.ts";

const EPHEMERAL = 64;

export async function handleReviewDeny(
  bot: AppealyBot,
  interaction: Interaction,
  submissionId: string,
  /** Set when the reviewer picked a denial reason from the menu. */
  chosenOutcomeId?: string,
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

  // ---------------------------------------------------------------------
  // Denial outcomes
  //
  // Same argument as the accept side: "denied, reapply in 30 days" and
  // "denied, don't reapply" are different decisions currently flattened into
  // one. When a form has them, pick first, then the reason modal.
  //
  // No confirm step here, deliberately. A denial applies no roles and is
  // reversible by re-inviting an application, so the accept side's "you are
  // about to hand out these permissions" summary has no equivalent — a
  // confirm would be a bare "are you sure?", which is exactly the prompt
  // that trains people to click through.
  // ---------------------------------------------------------------------
  const denyOutcomes = (
    (await db.query.formOutcomes.findMany({
      where: eq(schema.formOutcomes.formId, submission.formId),
    })) as unknown as FormOutcomeDTO[]
  ).filter((o) => o.decision === "deny");

  if (denyOutcomes.length > 0 && !chosenOutcomeId) {
    const level = await staffLevelFor(
      guildId,
      reviewer.id,
      interaction.member?.roles ?? [],
      interaction.member?.permissions ?? 0n,
    );
    const menu = buildOutcomeMenu(
      visibleOutcomes(denyOutcomes, level),
      level,
      submissionId,
      "deny",
    );
    if (menu) {
      return bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { flags: EPHEMERAL, components: [{ type: 1, components: [menu] }] },
      });
    }
    // No outcome available to this reviewer — fall through to the plain modal
    // rather than blocking a denial they're otherwise permitted to make.
  }

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9, // MODAL
    data: {
      // Chosen outcome rides along in `extra`, so the modal submit handler
      // can record it without a second lookup.
      customId: encodeCustomId("review", "deny_confirm", submissionId, chosenOutcomeId),
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
