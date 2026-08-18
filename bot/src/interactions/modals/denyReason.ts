// bot/src/interactions/modals/denyReason.ts

import { eq } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import { getGuild } from "../../core/guildLookup.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { findUnmanageableRoles } from "../../services/permissionService.ts";
import { sendTemplatedDm } from "../../services/dmService.ts";
import { logger } from "../../utils/logger.ts";

const EPHEMERAL = 64;

export async function handleDenyReasonModalSubmit(
  bot: AppealyBot,
  interaction: Interaction,
  submissionId: string,
) {
  const guildId = interaction.guildId;
  const reviewer = interaction.member?.user ?? interaction.user;
  if (!guildId || !reviewer) return;

  const reason =
    interaction.data?.components?.[0]?.components?.[0]?.value?.trim() || "No reason provided";

  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, submissionId),
    with: { form: true },
  });
  if (!submission || submission.status !== "pending") {
    return respond(bot, interaction, "This application is no longer pending.");
  }

  const form = submission.form;

  // denyRemoveRoleIds strips roles on denial (e.g. remove an "Applicant"
  // holding role); deniedGrantRoleIds adds roles on denial (e.g. tag the
  // user so staff can see at a glance they were previously denied).
  // pendingRoleIds are always cleared on any decision, same as accept.
  const denyTargetRoles = [...form.denyRemoveRoleIds, ...form.pendingRoleIds, ...form.deniedGrantRoleIds];
  if (denyTargetRoles.length > 0) {
    const unmanageable = await findUnmanageableRoles(bot, guildId, denyTargetRoles);
    const manageableRemove = [...form.denyRemoveRoleIds, ...form.pendingRoleIds].filter((r) => !unmanageable.includes(r));
    const manageableGrant = form.deniedGrantRoleIds.filter((r) => !unmanageable.includes(r));
    try {
      for (const roleId of manageableRemove) {
        await bot.helpers.removeRole(guildId, submission.applicantId, BigInt(roleId), "Application denied");
      }
      for (const roleId of manageableGrant) {
        await bot.helpers.addRole(guildId, submission.applicantId, BigInt(roleId), "Application denied");
      }
    } catch (err) {
      logger.error("Role update failed during deny", { submissionId, error: String(err) });
    }
  }

  await db
    .update(schema.submissions)
    .set({
      status: "denied",
      reviewerId: reviewer.id,
      reviewReason: reason,
      reviewedAt: new Date(),
    })
    .where(eq(schema.submissions.id, submissionId));

  if (submission.logMessageId) {
    try {
      await bot.helpers.editMessage(form.logChannelId, submission.logMessageId, {
        embeds: [
          {
            ...((interaction.message?.embeds?.[0] as Record<string, unknown>) ?? {}),
            color: 0xed4245,
            footer: {
              text: `Denied by ${reviewer.username} • Reason: ${reason} • Submission ID: ${submission.id}`,
            },
          },
        ],
        components: [],
      });
    } catch (err) {
      logger.warn("Failed to edit review message after deny", { submissionId, error: String(err) });
    }
  }

  // If a distinct denied-submission channel is configured, post a fresh
  // copy there too — mirrors reviewAccept.ts's acceptedChannelId handling.
  if (form.deniedChannelId && form.deniedChannelId !== form.logChannelId) {
    try {
      await bot.helpers.sendMessage(form.deniedChannelId, {
        embeds: [
          {
            ...((interaction.message?.embeds?.[0] as Record<string, unknown>) ?? {}),
            color: 0xed4245,
            footer: {
              text: `Denied by ${reviewer.username} • Reason: ${reason} • Submission ID: ${submission.id}`,
            },
          },
        ],
      });
    } catch (err) {
      logger.warn("Failed to post to denied-submission channel", { submissionId, error: String(err) });
    }
  }

  if (form.autoArchiveOnDecision && submission.threadId) {
    try {
      await bot.helpers.editChannel(submission.threadId, { archived: true, locked: true });
    } catch (err) {
      logger.warn("Failed to archive staff thread after deny", { submissionId, error: String(err) });
    }
  }

  const guildName = (await getGuild(bot, guildId))?.name ?? "the server";
  const applicantUser = await bot.helpers.getUser(submission.applicantId).catch(() => null);
  await sendTemplatedDm(bot, {
    formId: form.id,
    type: "denial",
    userId: submission.applicantId,
    username: applicantUser?.username ?? "there",
    userTag: applicantUser ? `${applicantUser.username}#${applicantUser.discriminator ?? "0"}` : submission.applicantId.toString(),
    guildName,
    formName: form.name,
    reason,
  });

  await respond(bot, interaction, "Application denied.");
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
