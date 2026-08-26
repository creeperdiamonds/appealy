// bot/src/interactions/buttons/reviewAccept.ts

import { eq } from "drizzle-orm";
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
import { sendTemplatedDm } from "../../services/dmService.ts";
import { logger } from "../../utils/logger.ts";
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
      const { embeds, components } = buildConfirm(outcome, submission.applicantId, submissionId, {
        formRemoveRoleIds: form.removeRoleIds,
        pendingRoleIds: form.pendingRoleIds,
        logChannelId: (outcome.logChannelId ?? form.acceptedChannelId ?? form.logChannelId)?.toString() ?? null,
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

  // The outcome's roles replace the form's; the form's removeRoleIds and
  // pendingRoleIds still apply on top, since those clear regardless of which
  // outcome was chosen.
  const rolesToGrant = outcome ? outcome.grantRoleIds : form.grantRoleIds;
  const rolesToRemove = [
    ...new Set([...(outcome?.removeRoleIds ?? []), ...form.removeRoleIds, ...form.pendingRoleIds]),
  ]; // pending roles always clear on decision
  const allTargetRoles = [...rolesToGrant, ...rolesToRemove];

  const unmanageable = await findUnmanageableRoles(bot, guildId, allTargetRoles);
  if (unmanageable.length > 0) {
    logger.warn("Some roles are above the bot's highest role and cannot be managed", {
      guildId: guildId.toString(),
      formId: form.id,
      unmanageable,
    });
  }

  const manageableGrant = rolesToGrant.filter((r) => !unmanageable.includes(r));
  const manageableRemove = rolesToRemove.filter((r) => !unmanageable.includes(r));

  try {
    for (const roleId of manageableGrant) {
      await bot.helpers.addRole(guildId, submission.applicantId, BigInt(roleId), "Application accepted");
    }
    for (const roleId of manageableRemove) {
      await bot.helpers.removeRole(guildId, submission.applicantId, BigInt(roleId), "Application accepted");
    }
  } catch (err) {
    logger.error("Role assignment failed during accept", {
      submissionId,
      error: String(err),
    });
  }

  // Ban-appeal-specific: accepting an appeal is the one case in this
  // codebase where "accepted" needs to reverse something Discord itself
  // did (a ban), not just grant/remove roles — the applicant isn't a
  // guild member to grant roles to in the first place. See
  // shared/schema/schema.ts's appealConfigs comment for the full design.
  let unbanWarning: string | null = null;
  if (form.kind === "appeal") {
    const appealConfig = await db.query.appealConfigs.findFirst({ where: eq(schema.appealConfigs.guildId, guildId) });
    // Default to unbanning even with no config row (or autoUnbanOnAccept
    // unset) — a missing config shouldn't silently leave an accepted
    // appeal banned, since "accepted" has an unambiguous real-world
    // meaning for a ban appeal specifically. autoUnbanOnAccept only needs
    // to be explicitly false to opt OUT of this.
    if (appealConfig?.autoUnbanOnAccept ?? true) {
      try {
        await bot.helpers.unbanMember(guildId, submission.applicantId, "Ban appeal accepted");
      } catch (err) {
        // Common, non-alarming causes: the user was already unbanned by
        // a staff member manually before this button was clicked, or the
        // bot lacks the Ban Members permission. Surface it to the
        // reviewer rather than only logging it, since "accepted" without
        // an actual unban is a state a moderator needs to know about.
        logger.warn("Unban failed after appeal acceptance", { submissionId, error: String(err) });
        unbanWarning =
          "Note: the automatic unban failed — the user may already be unbanned, or I'm missing the Ban Members permission. Please verify manually.";
      }
    }
  }

  await db
    .update(schema.submissions)
    .set({
      status: "accepted",
      reviewerId: reviewer.id,
      reviewedAt: new Date(),
      outcomeId: outcome?.id ?? null,
      // Snapshot, not a join — see shared/schema/outcomes.ts. "Accepted as
      // Moderator" has to stay true after the outcome is renamed or deleted.
      outcomeLabel: outcome?.label ?? null,
    })
    .where(eq(schema.submissions.id, submissionId));

  // Update the original (pending-channel) review message: disable
  // buttons, note the decision.
  if (submission.logMessageId) {
    try {
      await bot.helpers.editMessage(form.logChannelId, submission.logMessageId, {
        embeds: [
          {
            ...((interaction.message?.embeds?.[0] as Record<string, unknown>) ?? {}),
            color: 0x57f287,
            footer: { text: `Accepted by ${reviewer.username} • Submission ID: ${submission.id}` },
          },
        ],
        components: [], // remove buttons once decided
      });
    } catch (err) {
      logger.warn("Failed to edit review message after accept", { submissionId, error: String(err) });
    }
  }

  // If a distinct accepted-submission channel is configured, post a fresh
  // copy there too — matching the per-outcome-channel model (pending vs
  // accepted vs denied each get their own optional destination) rather
  // than relying solely on the edited-in-place pending post.
  // Outcome channel wins over the form's accepted channel — the point of a
  // per-outcome channel is that Moderator accepts can go somewhere other than
  // Trainee accepts.
  const acceptedChannel = outcome?.logChannelId ?? form.acceptedChannelId;
  if (acceptedChannel && acceptedChannel !== form.logChannelId) {
    try {
      await bot.helpers.sendMessage(acceptedChannel, {
        embeds: [
          {
            ...((interaction.message?.embeds?.[0] as Record<string, unknown>) ?? {}),
            color: 0x57f287,
            footer: {
              text: outcome
                ? `Accepted as ${outcome.label} by ${reviewer.username} • Submission ID: ${submission.id}`
                : `Accepted by ${reviewer.username} • Submission ID: ${submission.id}`,
            },
          },
        ],
      });
    } catch (err) {
      logger.warn("Failed to post to accepted-submission channel", { submissionId, error: String(err) });
    }
  }

  if (form.autoArchiveOnDecision && submission.threadId) {
    try {
      await bot.helpers.editChannel(submission.threadId, { archived: true, locked: true });
    } catch (err) {
      logger.warn("Failed to archive staff thread after accept", { submissionId, error: String(err) });
    }
  }

  const guildName = (await getGuild(bot, guildId))?.name ?? "the server";
  const applicantUser = await bot.helpers.getUser(submission.applicantId).catch(() => null);
  await sendTemplatedDm(bot, {
    formId: form.id,
    type: "acceptance",
    userId: submission.applicantId,
    username: applicantUser?.username ?? "there",
    userTag: applicantUser ? `${applicantUser.username}#${applicantUser.discriminator ?? "0"}` : submission.applicantId.toString(),
    guildName,
    formName: form.name,
  });

  const outcomeVerb = outcome
    ? `Accepted as ${outcome.label}`
    : form.kind === "appeal"
    ? "Appeal accepted"
    : "Application accepted";
  const messages = [
    unmanageable.length > 0
      ? `${outcomeVerb}. Note: ${unmanageable.length} role(s) could not be assigned because they are positioned above my highest role — move my role above them in Server Settings.`
      : `${outcomeVerb}.`,
  ];
  // A failed unban must reach the reviewer, not just the log. "Accepted" on an
  // appeal that left the user banned is the whole outcome they just approved.
  if (unbanWarning) messages.push(unbanWarning);

  await respond(bot, interaction, messages.join(" "));
}

// Kept as a one-line wrapper rather than rewriting ~6 call sites: the flag
// now lives on the deferral, so there is nothing left for this to decide.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
