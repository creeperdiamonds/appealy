// bot/src/services/reviewDecision.ts
//
// Accepting and denying an application, wherever the reviewer is: the Accept
// and Deny buttons on the review post, or the dashboard's Applications page
// (through the control server). Both used to live inside the button handlers,
// so the dashboard could only look. One copy means a decision made on the
// website does exactly what one made in Discord does: the same permission
// checks, roles, DMs, review post edit, log copies and thread archiving.
//
// The handlers keep what only Discord has: the outcome menu, the confirm step
// and the reason modal. They call in here once the reviewer has chosen.
//
// CLAIMED BEFORE ANYTHING HAPPENS
//
// The status moves from pending to its decision in one conditional update
// before any role or DM. Two reviewers deciding at once (now likely, with a
// dashboard and a Discord button for the same application) used to both pass
// the "still pending?" check and both hand out roles and DMs. Now the second
// one finds nothing to update and is told it was already decided.

import { and, eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { getGuild } from "../core/guildLookup.ts";
import { db, schema } from "../db/client.ts";
import { recordSubmissionEvent } from "./submissionEvents.ts";
import { canReviewForm, findUnmanageableRoles, staffLevelFor } from "./permissionService.ts";
import { sendTemplatedDm } from "./dmService.ts";
import { markReviewPost } from "./reviewPost.ts";
import { memberPermissions, type GuildInfo } from "./modCommands.ts";
import { outcomeExceedsReviewer, visibleOutcomes, type FormOutcomeDTO } from "../../../shared/schema/outcomes.ts";
import { logger } from "../utils/logger.ts";

const ADMINISTRATOR = 1n << 3n;

export interface Reviewer {
  id: bigint;
  username: string;
  roles: bigint[];
  /** Server-wide permission bits, as Discord adds them up. */
  permissions: bigint;
}

export type DecisionResult = { ok: true; message: string } | { ok: false; message: string };

type Clicked = Parameters<typeof markReviewPost>[5];

/** The reviewer behind a button press. */
export function reviewerFromInteraction(
  user: { id: bigint; username: string },
  member: { roles?: bigint[]; permissions?: { bitfield: bigint } } | undefined,
): Reviewer {
  return { id: user.id, username: user.username, roles: member?.roles ?? [], permissions: member?.permissions?.bitfield ?? 0n };
}

/** The reviewer as Discord describes a member, for calls from the dashboard. */
export async function reviewerFromMember(bot: AppealyBot, guildId: bigint, userId: bigint): Promise<Reviewer | null> {
  const [member, guild] = await Promise.all([
    bot.helpers.getMember(guildId, userId).catch(() => null),
    getGuild(bot, guildId),
  ]);
  if (!member || !guild) return null;
  const info: GuildInfo = {
    id: guildId,
    ownerId: guild.ownerId,
    roles: [...guild.roles.values()].map((r) => ({ id: r.id, position: r.position, permissions: r.permissions?.bitfield ?? 0n })),
  };
  const user = member.user ?? (await bot.helpers.getUser(userId).catch(() => null));
  return {
    id: userId,
    username: user?.username ?? userId.toString(),
    roles: member.roles,
    permissions: memberPermissions(info, userId, member.roles),
  };
}

/** What this reviewer may do with one pending application: for the dashboard's buttons. */
export async function reviewOptions(guildId: bigint, submissionId: string, reviewer: Reviewer) {
  const submission = await db.query.submissions.findFirst({
    where: and(eq(schema.submissions.id, submissionId), eq(schema.submissions.guildId, guildId)),
    columns: { formId: true, status: true },
  });
  if (!submission) return { canReview: false as const, reason: "This application no longer exists." };
  if (submission.status !== "pending") return { canReview: false as const, reason: `It was already ${submission.status}.` };
  if (!(await canReviewForm(guildId, submission.formId, reviewer.id, reviewer.roles, reviewer.permissions))) {
    return { canReview: false as const, reason: "You don't have permission to review this form." };
  }
  const level = await staffLevelFor(guildId, reviewer.id, reviewer.roles, reviewer.permissions);
  const outcomes = await outcomesFor(submission.formId);
  const brief = (o: FormOutcomeDTO) => ({
    id: o.id,
    label: o.label,
    description: o.description,
    grantRoleIds: o.grantRoleIds,
    removeRoleIds: o.removeRoleIds,
  });
  const accept = outcomes.filter((o) => o.decision === "accept");
  return {
    canReview: true as const,
    // Null: the form has no accept outcomes, so there is one plain Accept.
    acceptOutcomes: accept.length ? visibleOutcomes(accept, level).map(brief) : null,
    denyOutcomes: visibleOutcomes(outcomes.filter((o) => o.decision === "deny"), level).map(brief),
  };
}

async function outcomesFor(formId: string): Promise<FormOutcomeDTO[]> {
  return (await db.query.formOutcomes.findMany({ where: eq(schema.formOutcomes.formId, formId) })) as unknown as FormOutcomeDTO[];
}

/** The application, scoped to its server, if it's still waiting and this reviewer may decide it. */
async function loadForDecision(guildId: bigint, submissionId: string, reviewer: Reviewer) {
  const submission = await db.query.submissions.findFirst({
    where: and(eq(schema.submissions.id, submissionId), eq(schema.submissions.guildId, guildId)),
    with: { form: true },
  });
  if (!submission) return { error: "This submission no longer exists." };
  const noun = submission.form.kind === "appeal" ? "appeal" : "application";
  if (submission.status !== "pending") return { error: `This ${noun} was already marked **${submission.status}**.` };
  if (!(await canReviewForm(guildId, submission.formId, reviewer.id, reviewer.roles, reviewer.permissions))) {
    return { error: `You don't have permission to review this ${noun}.` };
  }
  return { submission };
}

/**
 * Moves a pending application to its decision, or reports that someone else
 * already did. Everything after this is a consequence of a decision that has
 * been made exactly once.
 */
async function claim(submissionId: string, set: Partial<typeof schema.submissions.$inferInsert>): Promise<boolean> {
  const rows = await db
    .update(schema.submissions)
    .set({ ...set, reviewedAt: new Date() })
    .where(and(eq(schema.submissions.id, submissionId), eq(schema.submissions.status, "pending")))
    .returning({ id: schema.submissions.id });
  return rows.length > 0;
}

/**
 * Re-checked here rather than trusted from the caller: an outcome id can come
 * from a guessable custom id or a dashboard request.
 */
async function resolveOutcome(
  bot: AppealyBot,
  guildId: bigint,
  formId: string,
  reviewer: Reviewer,
  decision: "accept" | "deny",
  outcomeId: string | undefined,
): Promise<{ outcome: FormOutcomeDTO | null } | { error: string }> {
  const all = (await outcomesFor(formId)).filter((o) => o.decision === decision);
  if (!outcomeId) {
    // A form with accept outcomes is accepted through one of them; the plain
    // path is only for forms that have none. Denial outcomes are optional.
    if (decision === "accept" && all.length > 0) return { error: "Pick how to accept this one." };
    return { outcome: null };
  }
  const level = await staffLevelFor(guildId, reviewer.id, reviewer.roles, reviewer.permissions);
  const outcome = visibleOutcomes(all, level).find((o) => o.id === outcomeId) ?? null;
  if (!outcome) return { error: "That outcome isn't available to you." };

  // A reviewer may not hand out a role at or above their own highest. Discord
  // enforces that for the bot, not for the person pressing the button.
  // Skipped for Administrators, who can assign any role by hand anyway.
  if ((reviewer.permissions & ADMINISTRATOR) !== ADMINISTRATOR && outcome.grantRoleIds.length) {
    const roles = (await getGuild(bot, guildId))?.roles;
    if (roles) {
      const positionOf = (id: bigint) => Number(roles.get(id)?.position ?? 0);
      const reviewerTop = Math.max(0, ...reviewer.roles.map(positionOf));
      if (outcomeExceedsReviewer(outcome.grantRoleIds.map((r) => positionOf(BigInt(r))), reviewerTop)) {
        return {
          error: `**${outcome.label}** grants a role at or above your own highest role, so I won't apply it. ` +
            `Ask someone higher in the role list to review this one.`,
        };
      }
    }
  }
  return { outcome };
}

async function applyRoles(
  bot: AppealyBot,
  guildId: bigint,
  userId: bigint,
  grant: string[],
  remove: string[],
  why: string,
  submissionId: string,
): Promise<string[]> {
  const unmanageable = await findUnmanageableRoles(bot, guildId, [...grant, ...remove]);
  if (unmanageable.length > 0) {
    logger.warn("Some roles are above the bot's highest role and cannot be managed", {
      guildId: guildId.toString(),
      submissionId,
      unmanageable,
    });
  }
  try {
    for (const roleId of grant.filter((r) => !unmanageable.includes(r))) {
      await bot.helpers.addRole(guildId, userId, BigInt(roleId), why);
    }
    for (const roleId of remove.filter((r) => !unmanageable.includes(r))) {
      await bot.helpers.removeRole(guildId, userId, BigInt(roleId), why);
    }
  } catch (err) {
    logger.error(`Role update failed: ${why}`, { submissionId, error: String(err) });
  }
  return unmanageable;
}

type LoadedSubmission = NonNullable<Awaited<ReturnType<typeof loadForDecision>>["submission"]>;

/** The review post, the decided-channel copy, the thread and the applicant's DM. */
async function announce(
  bot: AppealyBot,
  guildId: bigint,
  submission: LoadedSubmission,
  opts: { color: number; footer: string; copyFooter: string; copyChannel: bigint | string | null; dm: "acceptance" | "denial"; reason?: string },
  clicked?: Clicked,
) {
  const form = submission.form;
  const reviewEmbed = submission.logMessageId
    ? await markReviewPost(bot, form.logChannelId, submission.logMessageId, submission.id, { color: opts.color, footer: opts.footer }, clicked)
    : null;
  // Without the post's own embed, a plain card naming who and what.
  const copyOf = reviewEmbed ?? {
    title: `Application — ${form.name}`,
    description: `Submitted by <@${submission.applicantId}>`,
  };
  if (opts.copyChannel && String(opts.copyChannel) !== String(form.logChannelId)) {
    try {
      await bot.helpers.sendMessage(opts.copyChannel, {
        embeds: [{ ...copyOf, color: opts.color, footer: { text: opts.copyFooter } }],
      });
    } catch (err) {
      logger.warn("Failed to post to the decided-application channel", { submissionId: submission.id, error: String(err) });
    }
  }
  if (form.autoArchiveOnDecision && submission.threadId) {
    try {
      await bot.helpers.editChannel(submission.threadId, { archived: true, locked: true });
    } catch (err) {
      logger.warn("Failed to archive staff thread after a decision", { submissionId: submission.id, error: String(err) });
    }
  }
  const guildName = (await getGuild(bot, guildId))?.name ?? "the server";
  const applicantUser = await bot.helpers.getUser(submission.applicantId).catch(() => null);
  await sendTemplatedDm(bot, {
    formId: form.id,
    type: opts.dm,
    userId: submission.applicantId,
    username: applicantUser?.username ?? "there",
    userTag: applicantUser ? `${applicantUser.username}#${applicantUser.discriminator ?? "0"}` : submission.applicantId.toString(),
    guildName,
    formName: form.name,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  });
}

const ROLE_NOTE = "Appealy needs the Manage Roles permission, with its role above them (Server Settings → Roles).";

export async function acceptSubmission(
  bot: AppealyBot,
  args: { guildId: bigint; submissionId: string; reviewer: Reviewer; outcomeId?: string; clicked?: Clicked },
): Promise<DecisionResult> {
  const { guildId, submissionId, reviewer } = args;
  const loaded = await loadForDecision(guildId, submissionId, reviewer);
  if (!loaded.submission) return { ok: false, message: loaded.error! };
  const submission = loaded.submission;
  const form = submission.form;

  const resolved = await resolveOutcome(bot, guildId, form.id, reviewer, "accept", args.outcomeId);
  if ("error" in resolved) return { ok: false, message: resolved.error };
  const outcome = resolved.outcome;

  const claimed = await claim(submissionId, {
    status: "accepted",
    reviewerId: reviewer.id,
    outcomeId: outcome?.id ?? null,
    // Snapshot, not a join — see shared/schema/outcomes.ts.
    outcomeLabel: outcome?.label ?? null,
  });
  if (!claimed) return { ok: false, message: "Someone else decided this one a moment ago." };

  await recordSubmissionEvent({
    guildId,
    submissionId,
    actorId: reviewer.id,
    action: "accepted",
    detail: outcome?.label ? { outcomeLabel: outcome.label } : undefined,
  });

  // What an appeal-kind submission is appealing. Null only on submissions
  // from before timeout and restriction appeals existed, all of them bans.
  const appealKind = form.kind === "appeal" ? (submission.appealKind ?? "ban") : null;
  const appealConfig = appealKind
    ? await db.query.appealConfigs.findFirst({ where: eq(schema.appealConfigs.guildId, guildId) })
    : null;
  // Accepting a restriction appeal lifts the role it was about through the
  // same removal path, and the same hierarchy check, as every other role.
  const liftedRoleIds =
    appealKind === "restriction" && (appealConfig?.liftRestrictionOnAccept ?? true) ? submission.appealRoleIds : [];

  // The outcome's roles replace the form's; the form's removeRoleIds and
  // pendingRoleIds still apply on top, since those clear whichever outcome.
  const grant = outcome ? outcome.grantRoleIds : form.grantRoleIds;
  const remove = [...new Set([...(outcome?.removeRoleIds ?? []), ...form.removeRoleIds, ...form.pendingRoleIds, ...liftedRoleIds])];
  const unmanageable = await applyRoles(bot, guildId, submission.applicantId, grant, remove, "Application accepted", submissionId);

  let liftWarning: string | null = null;
  if (appealKind === "ban" && (appealConfig?.autoUnbanOnAccept ?? true)) {
    try {
      await bot.helpers.unbanMember(guildId, submission.applicantId, "Ban appeal accepted");
    } catch (err) {
      // Usually: already unbanned by hand, or no Ban Members permission.
      // "Accepted" without an unban is something the reviewer has to know.
      logger.warn("Unban failed after appeal acceptance", { submissionId, error: String(err) });
      liftWarning =
        "Note: the automatic unban failed — the user may already be unbanned, or I'm missing the Ban Members permission. Please verify manually.";
    }
  }
  if (appealKind === "timeout" && (appealConfig?.liftTimeoutOnAccept ?? true)) {
    try {
      await bot.helpers.editMember(guildId, submission.applicantId, { communicationDisabledUntil: null }, "Timeout appeal accepted");
    } catch (err) {
      logger.warn("Lifting the timeout failed after appeal acceptance", { submissionId, error: String(err) });
      liftWarning =
        "Note: lifting the timeout failed — it may already have ended, or I'm missing the Timeout Members permission. Please check manually.";
    }
  }
  if (liftedRoleIds.some((r) => unmanageable.includes(r))) {
    liftWarning =
      "Note: I couldn't remove the restriction role — it sits above my highest role. Remove it by hand, or move my role above it.";
  }

  // Outcome channel wins over the form's accepted channel: the point of a
  // per-outcome channel is that Moderator accepts can go somewhere else.
  await announce(bot, guildId, submission, {
    color: 0x57f287,
    footer: `Accepted by ${reviewer.username} • Submission ID: ${submission.id}`,
    copyFooter: outcome
      ? `Accepted as ${outcome.label} by ${reviewer.username} • Submission ID: ${submission.id}`
      : `Accepted by ${reviewer.username} • Submission ID: ${submission.id}`,
    copyChannel: outcome?.logChannelId ?? form.acceptedChannelId,
    dm: "acceptance",
  }, args.clicked);

  const verb = outcome ? `Accepted as ${outcome.label}` : form.kind === "appeal" ? "Appeal accepted" : "Application accepted";
  const messages = [
    unmanageable.length > 0 ? `${verb}. Note: ${unmanageable.length} role(s) could not be assigned. ${ROLE_NOTE}` : `${verb}.`,
  ];
  if (liftWarning) messages.push(liftWarning);
  return { ok: true, message: messages.join(" ") };
}

export async function denySubmission(
  bot: AppealyBot,
  args: { guildId: bigint; submissionId: string; reviewer: Reviewer; reason: string; outcomeId?: string; clicked?: Clicked },
): Promise<DecisionResult> {
  const { guildId, submissionId, reviewer } = args;
  const reason = args.reason.trim() || "No reason provided";
  const loaded = await loadForDecision(guildId, submissionId, reviewer);
  if (!loaded.submission) return { ok: false, message: loaded.error! };
  const submission = loaded.submission;
  const form = submission.form;

  const resolved = await resolveOutcome(bot, guildId, form.id, reviewer, "deny", args.outcomeId);
  if ("error" in resolved) return { ok: false, message: resolved.error };
  const outcome = resolved.outcome;

  const claimed = await claim(submissionId, {
    status: "denied",
    reviewerId: reviewer.id,
    reviewReason: reason,
    outcomeId: outcome?.id ?? null,
    outcomeLabel: outcome?.label ?? null,
  });
  if (!claimed) return { ok: false, message: "Someone else decided this one a moment ago." };

  // The reason is snapshotted here as well as on the row, because the row's
  // copy is replaced if the application is ever reopened and decided again.
  await recordSubmissionEvent({
    guildId,
    submissionId,
    actorId: reviewer.id,
    action: "denied",
    detail: { reason, ...(outcome?.label ? { outcomeLabel: outcome.label } : {}) },
  });

  // denyRemoveRoleIds strip on denial, deniedGrantRoleIds tag on denial,
  // pendingRoleIds always clear on a decision; a denial outcome's own roles
  // go on top.
  const unmanageable = await applyRoles(
    bot,
    guildId,
    submission.applicantId,
    [...new Set([...form.deniedGrantRoleIds, ...(outcome?.grantRoleIds ?? [])])],
    [...new Set([...form.denyRemoveRoleIds, ...form.pendingRoleIds, ...(outcome?.removeRoleIds ?? [])])],
    "Application denied",
    submissionId,
  );

  const footer = `Denied by ${reviewer.username}${outcome ? ` (${outcome.label})` : ""} • Reason: ${reason} • Submission ID: ${submission.id}`;
  await announce(bot, guildId, submission, {
    color: 0xed4245,
    footer,
    copyFooter: footer,
    copyChannel: form.deniedChannelId,
    dm: "denial",
    reason,
  }, args.clicked);

  const done = outcome ? `Denied: ${outcome.label}.` : "Application denied.";
  return {
    ok: true,
    message: unmanageable.length > 0 ? `${done} Note: ${unmanageable.length} role(s) could not be changed. ${ROLE_NOTE}` : done,
  };
}
