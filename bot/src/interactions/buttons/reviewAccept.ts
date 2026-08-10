// bot/src/interactions/buttons/reviewAccept.ts

import { eq } from "drizzle-orm";
import type { Interaction } from "@discordeno/bot";
import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { canReviewForm, findUnmanageableRoles } from "../../services/permissionService.ts";
import { sendTemplatedDm } from "../../services/dmService.ts";
import { logger } from "../../utils/logger.ts";

const EPHEMERAL = 64;

export async function handleReviewAccept(
  bot: AppealyBot,
  interaction: Interaction,
  submissionId: string,
) {
  const guildId = interaction.guildId;
  const reviewer = interaction.member?.user ?? interaction.user;
  if (!guildId || !reviewer) return;

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
    interaction.member?.permissions ?? 0n,
  );
  if (!allowed) {
    const noun = submission.form.kind === "appeal" ? "appeal" : "application";
    return respond(bot, interaction, `You don't have permission to review this ${noun}.`);
  }

  const form = submission.form;
  const rolesToGrant = form.grantRoleIds;
  const rolesToRemove = [...form.removeRoleIds, ...form.pendingRoleIds]; // pending roles always clear on decision
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
  if (form.acceptedChannelId && form.acceptedChannelId !== form.logChannelId) {
    try {
      await bot.helpers.sendMessage(form.acceptedChannelId, {
        embeds: [
          {
            ...((interaction.message?.embeds?.[0] as Record<string, unknown>) ?? {}),
            color: 0x57f287,
            footer: { text: `Accepted by ${reviewer.username} • Submission ID: ${submission.id}` },
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

  const guildName = (await bot.cache?.guilds?.get(guildId))?.name ?? "the server";
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

  const outcomeVerb = form.kind === "appeal" ? "Appeal accepted" : "Application accepted";
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

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
