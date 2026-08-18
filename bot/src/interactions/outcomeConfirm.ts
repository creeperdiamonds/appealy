// bot/src/interactions/outcomeConfirm.ts
//
// Confirmation step between choosing an outcome and applying it.
//
// ---------------------------------------------------------------------------
// Why this shows a summary instead of asking "are you sure?"
// ---------------------------------------------------------------------------
// A confirmation that appears on every single accept gets clicked through
// within a day. That's not a discipline problem — it's what happens to any
// prompt that carries no information: the reviewer learns the second click is
// part of the gesture and stops reading. The prompt then costs a click on
// every review and prevents nothing, which is the worst of both.
//
// So this one carries information the reviewer doesn't already have:
//
//     Accept @someone as Moderator?
//
//     Gains     @Moderator, @Staff
//     Loses     @Applicant, @Pending Review
//     They get  a DM with your accept message
//     Logged in #staff-log
//
//     [ Confirm ]  [ Cancel ]
//
// Now it's a review step rather than a speed bump. The reviewer picked a label
// from a menu; this is where they find out that label also strips @Trusted, or
// that the role list is empty because someone misconfigured the outcome. Those
// are things worth catching, and they keep the step worth reading even at the
// fortieth application — which is what keeps the click from becoming reflex.
//
// ---------------------------------------------------------------------------
// Privileged outcomes look different on purpose
// ---------------------------------------------------------------------------
// Same reflex problem, one layer up: if every confirm looks identical, the
// dangerous one doesn't register as dangerous. Outcomes with a raised
// minStaffLevel get red styling, a warning line, and a destructive-styled
// button, so the one that hands out ban permissions doesn't look like the one
// that hands out @Trainee.
//
// ---------------------------------------------------------------------------
// Ephemeral, and why that matters here
// ---------------------------------------------------------------------------
// The confirm is only visible to the reviewer who chose. Two reviewers can
// work the same queue without seeing each other's half-made decisions, and an
// abandoned confirm leaves no litter in the channel.
//
// It does mean the underlying submission can be decided by someone else while
// a confirm sits open — so the handler re-checks status at confirm time rather
// than trusting the state from when the menu was opened.

import type { FormOutcomeDTO } from "../../../shared/schema/outcomes.ts";
import type { MessageComponent } from "@discordeno/bot";
import type { ActionRow } from "@discordeno/bot";
import { MessageComponentTypes, ButtonStyles } from "@discordeno/bot";

const CONFIRM_TTL_MS = 120_000;

export interface PendingConfirm {
  submissionId: string;
  outcomeId: string;
  reviewerId: bigint;
  expiresAt: number;
}

/**
 * In-memory, deliberately.
 *
 * A dropped confirm on restart is harmless — the reviewer picks again, and
 * nothing has been applied. Putting this in Redis would add a network round
 * trip to every review to protect a two-minute window that costs one extra
 * click when it's lost.
 */
const pending = new Map<string, PendingConfirm>();

/**
 * Key is submission+outcome+reviewer rather than the interaction token.
 *
 * The confirm button arrives as a NEW interaction with its own token, so the
 * token that staged it isn't available to look up on the way back. Keying on
 * the three things the button's custom_id can carry is what makes the round
 * trip work — and including reviewerId means two reviewers confirming the same
 * outcome on the same submission don't share an entry.
 */
export const confirmKey = (submissionId: string, outcomeId: string, reviewerId: bigint) =>
  `${submissionId}:${outcomeId}:${reviewerId}`;

export function stageConfirm(
  submissionId: string,
  outcomeId: string,
  reviewerId: bigint,
): void {
  pending.set(confirmKey(submissionId, outcomeId, reviewerId), {
    submissionId,
    outcomeId,
    reviewerId,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
}

/**
 * Consumes the staged confirm. Single-use: a double-click on Confirm must not
 * apply the outcome twice, and deleting on read is a cheaper guarantee than
 * making the whole accept path idempotent.
 */
export function takeConfirm(
  submissionId: string,
  outcomeId: string,
  reviewerId: bigint,
): PendingConfirm | null {
  const key = confirmKey(submissionId, outcomeId, reviewerId);
  const entry = pending.get(key);
  if (!entry) return null;
  pending.delete(key);

  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

/** Periodic sweep so an abandoned confirm doesn't sit in memory forever. */
export function startConfirmSweeper() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  }, 60_000);
  if (typeof Deno !== "undefined") Deno.unrefTimer(timer);
}

const roleList = (ids: string[]) =>
  ids.length > 0 ? ids.map((id) => `<@&${id}>`).join(", ") : "_none_";

/**
 * The confirm message.
 *
 * `privileged` drives the visual difference. It's derived from minStaffLevel
 * rather than being a separate flag, so an outcome can't be restricted to
 * owners while still looking routine at the moment it's applied.
 */
export function buildConfirm(
  outcome: FormOutcomeDTO,
  applicantId: bigint,
  submissionId: string,
  opts: {
    /** Roles removed on any accept, from the form, on top of the outcome's. */
    formRemoveRoleIds: string[];
    pendingRoleIds: string[];
    logChannelId: string | null;
    willDm: boolean;
    /** Roles the bot can see but can't assign — worth knowing BEFORE clicking. */
    unmanageableRoleIds: string[];
  },
) {
  const privileged = outcome.minStaffLevel > 0;
  const removes = [
    ...new Set([...outcome.removeRoleIds, ...opts.formRemoveRoleIds, ...opts.pendingRoleIds]),
  ];

  const fields = [
    { name: "Gains", value: roleList(outcome.grantRoleIds), inline: true },
    { name: "Loses", value: roleList(removes), inline: true },
  ];

  if (opts.willDm) {
    fields.push({ name: "They get", value: "a DM with the accept message", inline: false });
  }
  if (opts.logChannelId) {
    fields.push({ name: "Logged in", value: `<#${opts.logChannelId}>`, inline: false });
  }

  // Surfaced here rather than after the fact. The current accept path reports
  // unassignable roles in the result message, which is too late — the reviewer
  // has already told the applicant they're a Moderator.
  if (opts.unmanageableRoleIds.length > 0) {
    fields.push({
      name: "⚠️ Won't be applied",
      value:
        `${roleList(opts.unmanageableRoleIds)} — these sit above my highest role. ` +
        `Move my role above them in Server Settings first.`,
      inline: false,
    });
  }

  return {
    flags: 64, // ephemeral
    embeds: [
      {
        title: `Accept <@${applicantId}> as ${outcome.label}?`,
        description: privileged
          ? "**This is a restricted outcome.** Read the roles before confirming."
          : outcome.description ?? undefined,
        color: privileged ? 0xff4d6d : 0x5865f2,
        fields,
      },
    ],
    components: [
      {
        type: MessageComponentTypes.ActionRow,
        // Exactly two: confirm and cancel.
        components: [
          {
            type: MessageComponentTypes.Button,
            // Red for privileged outcomes. Discord's destructive style is the
            // only visual signal that survives a reviewer skim-reading.
            style: privileged ? ButtonStyles.Danger : ButtonStyles.Success,
            label: privileged ? `Yes — grant ${outcome.label}` : "Confirm",
            // namespace:action:entityId:extra — outcome id, then submission id.
            customId: `review:confirm:${outcome.id}:${submissionId}`,
          },
          {
            type: MessageComponentTypes.Button,
            style: ButtonStyles.Secondary,
            label: "Cancel",
            customId: "review:cancel",
          },
        ] as ActionRow["components"],
      },
    ] as MessageComponent[],
  };
}
