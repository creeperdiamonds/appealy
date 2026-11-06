// bot/src/interactions/buttons/reviewAccept.ts

import { eq } from "drizzle-orm";
import { confirmationWithAsk } from "../../services/feedbackAsk.ts";
import { MessageComponentTypes } from "@discordeno/bot";
import type { MessageComponent } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import { getGuild } from "../../core/guildLookup.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { canReviewForm, findUnmanageableRoles, staffLevelFor } from "../../services/permissionService.ts";
import {
  buildOutcomeMenu, shouldConfirm, visibleOutcomes, outcomeExceedsReviewer,
  type FormOutcomeDTO,
} from "../../../../shared/schema/outcomes.ts";
import { buildConfirm, stageConfirm, takeConfirm } from "../outcomeConfirm.ts";
import { acceptSubmission, reviewerFromInteraction } from "../../services/reviewDecision.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleReviewAccept(
  bot: AppealyBot,
  interaction: Interaction,
  submissionId: string,
  /**
   * Set when the reviewer picked from the outcome menu. Undefined means the
   * plain Accept button — either a form with no outcomes, or a reviewer who
   * can pick none of them.
   */
  chosenOutcomeId?: string,
  /** Present when this call is the confirm click rather than the selection. */
  confirmToken?: string,
) {
  const guildId = interaction.guildId;
  const reviewer = interaction.member?.user ?? interaction.user;
  if (!guildId || !reviewer) return;

  // Answer Discord before doing any of it. What follows is ten to fifteen
  // sequential REST calls plus five queries; the three-second window is not
  // close, and the reviewer was being shown "This interaction failed" while
  // the role, the DM and the unban all went through.
  await defer(bot, interaction, { ephemeral: true });

  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, submissionId),
    with: { form: true },
  });
  if (!submission) {
    return respond(bot, interaction, "This submission no longer exists.");
  }
  if (submission.status !== "pending") {
    const noun = submission.form.kind === "appeal" ? "appeal" : "application";
    return respond(bot, interaction, `This ${noun} was already marked **${submission.status}**.`);
  }

  const allowed = await canReviewForm(
    guildId,
    submission.formId,
    reviewer.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions?.bitfield ?? 0n,
  );
  if (!allowed) {
    const noun = submission.form.kind === "appeal" ? "appeal" : "application";
    return respond(bot, interaction, `You don't have permission to review this ${noun}.`);
  }

  const form = submission.form;

  // ---------------------------------------------------------------------
  // Outcome resolution
  //
  // A form with no outcome rows behaves exactly as before: the form's own
  // grantRoleIds, one Accept button, no menu, no confirm. Everything below
  // treats that case as a single implicit outcome so there's one role-
  // application path rather than two that can drift apart.
  // ---------------------------------------------------------------------
  // Accept-side only. Denial outcomes live in the same table and are read by
  // handleReviewDeny — filtering here rather than in the query keeps one
  // obvious place where the two paths diverge.
  const outcomes = (
    (await db.query.formOutcomes.findMany({
      where: eq(schema.formOutcomes.formId, form.id),
    })) as unknown as FormOutcomeDTO[]
  ).filter((o) => o.decision === "accept");

  let outcome: FormOutcomeDTO | null = null;

  if (outcomes.length > 0) {
    const level = await staffLevelFor(
      guildId,
      reviewer.id,
      interaction.member?.roles ?? [],
      interaction.member?.permissions?.bitfield ?? 0n,
    );
    const allowed = visibleOutcomes(outcomes, level);

    if (allowed.length === 0) {
      // Can review, but can't grant any of the configured outcomes. Say so
      // plainly rather than showing an empty menu — this is a configuration
      // problem for whoever set the levels, and it should be legible.
      return respond(
        bot,
        interaction,
        "You can review this form but aren't permitted to grant any of its outcomes. An admin needs to adjust the outcome permissions.",
      );
    }

    if (!chosenOutcomeId) {
      // First click: show the menu instead of accepting.
      const menu = buildOutcomeMenu(allowed, level, submissionId);
      // Null when there is nothing this reviewer may pick. The check above
      // covers the usual case, but the builder is allowed to return nothing
      // and a row containing null is not a message Discord will accept.
      if (!menu) {
        return respond(
          bot,
          interaction,
          "No outcomes are available to you on this form right now.",
        );
      }
      const components: MessageComponent[] = [
        { type: MessageComponentTypes.ActionRow, components: [menu] },
      ];
      return finish(bot, interaction, { components });
    }

    // Re-check against `allowed`, not `outcomes`. Custom_ids are guessable, so
    // a reviewer could otherwise fire an outcome above their level by hand.
    outcome = allowed.find((o) => o.id === chosenOutcomeId) ?? null;
    if (!outcome) {
      return respond(bot, interaction, "That outcome isn't available to you.");
    }

    // Second guard, independent of staff level: a reviewer may not grant a
    // role at or above their own highest.
    //
    // minStaffLevel governs which outcomes appear; this governs whether the
    // reviewer actually outranks what they're handing out. They're different
    // questions — an admin-level delegation can sit on a Discord role near the
    // bottom of the hierarchy, and Discord enforces hierarchy for the BOT but
    // not for the human clicking a button.
    //
    // Skipped for ADMINISTRATOR, who can assign any role by hand anyway;
    // blocking them here would be theatre.
    const isAdmin = interaction.member?.permissions?.has("ADMINISTRATOR") ?? false;
    if (!isAdmin) {
      const guildRoles = (await getGuild(bot, guildId))?.roles;
      if (guildRoles) {
        const positionOf = (id: bigint) => Number(guildRoles.get(id)?.position ?? 0);
        const reviewerTop = Math.max(
          0,
          ...(interaction.member?.roles ?? []).map(positionOf),
        );
        const grantPositions = outcome.grantRoleIds.map((r) => positionOf(BigInt(r)));

        if (outcomeExceedsReviewer(grantPositions, reviewerTop)) {
          return respond(
            bot,
            interaction,
            `**${outcome.label}** grants a role at or above your own highest role, so I won't apply it. ` +
              `Ask someone higher in the role list to review this one.`,
          );
        }
      }
    }

    if (shouldConfirm(outcome) && !confirmToken) {
      const unmanageablePreview = await findUnmanageableRoles(bot, guildId, [
        ...outcome.grantRoleIds,
        ...outcome.removeRoleIds,
      ]);
      stageConfirm(submissionId, outcome.id, reviewer.id);
      // buildConfirm() also returns a `flags` field for its original callers
      // that respond fresh; dropped here since the ephemeral flag already
      // landed on the deferral and finish() must not receive it — see
      // finish()'s own doc comment.
      // Where the decision gets written down: the outcome's own channel, else
      // the form's accepted channel, else its review channel. Checked rather
      // than mentioned blind: a deleted channel, or one from another server
      // (an imported form), rendered as "#unknown" with no hint what to fix.
      const logTarget = outcome.logChannelId ?? form.acceptedChannelId ?? form.logChannelId;
      const logChannel = logTarget
        ? await bot.helpers.getChannel(logTarget).catch(() => null)
        : null;
      const { embeds, components } = buildConfirm(outcome, submission.applicantId, submissionId, {
        formRemoveRoleIds: form.removeRoleIds,
        pendingRoleIds: form.pendingRoleIds,
        logChannelId: logTarget?.toString() ?? null,
        logChannelName: logChannel && logChannel.guildId === guildId ? (logChannel.name ?? null) : null,
        willDm: true,
        unmanageableRoleIds: unmanageablePreview,
      });
      return finish(bot, interaction, { embeds, components });
    }

    if (confirmToken) {
      // Single-use and bound to the reviewer. Consumed here so a double-click
      // on Confirm can't apply the outcome twice.
      const staged = takeConfirm(submissionId, outcome.id, reviewer.id);
      if (!staged) {
        return respond(bot, interaction, "That confirmation expired. Pick an outcome again.");
      }
    }
  }

  // Everything from here is shared with the dashboard (services/reviewDecision.ts),
  // which re-checks the outcome and the reviewer's permission itself.
  const result = await acceptSubmission(bot, {
    guildId,
    submissionId,
    reviewer: reviewerFromInteraction(reviewer, interaction.member),
    outcomeId: outcome?.id,
    clicked: interaction.message,
  });
  if (!result.ok) return respond(bot, interaction, result.message);

  // The ask for feedback rides on this private confirmation, once per person
  // (services/feedbackAsk.ts).
  await finish(bot, interaction, await confirmationWithAsk(guildId, reviewer.id, result.message));
}

// Kept as a one-line wrapper rather than rewriting ~6 call sites: the flag
// now lives on the deferral, so there is nothing left for this to decide.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
