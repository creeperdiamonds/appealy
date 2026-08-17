// shared/schema/outcomes.ts
//
// Multiple accept outcomes per form.
//
// The problem
// -----------
// Review is modelled everywhere as accept/deny, which isn't how staffing
// decisions actually work. Someone applies for Trainee and reads as ready for
// Moderator; someone applies for Moderator and is worth taking on as Trainee.
// Today both require accepting into the wrong role and then fixing it by hand,
// or denying a good applicant and asking them to apply again.
//
// An outcome is "accept, as X" — its own roles, its own message, its own log
// channel. The reviewer picks one instead of pressing a single Accept.
//
// ---------------------------------------------------------------------------
// THE PART THAT MATTERS MOST: outcomes are a privilege escalation surface
// ---------------------------------------------------------------------------
// The moment a form can grant more than one role, "who may choose which
// outcome" becomes a security question rather than a preference.
//
// Consider a trainee-moderator who has permission to review trainee
// applications — entirely normal, and the reason this feature is wanted. If
// every outcome is available to every reviewer, that trainee can accept their
// own friend as Head Moderator through the trainee form. They never needed
// Manage Roles. The application form became the escalation path.
//
// So every outcome carries `minStaffLevel`, checked against the reviewer's
// staffPermissions row at click time, and an outcome the reviewer can't grant
// is not rendered for them at all — not rendered-and-rejected, because a
// visible button that always fails teaches people the bot is broken.
//
// A second, cheaper guard: an outcome may not grant a role at or above the
// reviewer's own highest role. Discord already enforces this for the bot;
// this enforces it for the human, which Discord does not.
//
// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------
// A form with zero outcome rows behaves exactly as before: one Accept button
// using forms.grantRoleIds / removeRoleIds. Nothing migrates, nothing changes
// for existing guilds until someone adds an outcome.

import {
  pgTable, pgEnum, text, bigint, integer, boolean, jsonb, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { forms, submissions } from "./schema.ts";

export const outcomeDecisionEnum = pgEnum("outcome_decision", ["accept", "deny"]);

export const formOutcomes = pgTable(
  "form_outcomes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    formId: text("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),

    /**
     * Which decision this outcome belongs to.
     *
     * Denials have the same shape as accepts and the same argument behind
     * them: "denied, reapply in 30 days" and "denied, don't reapply" are
     * different decisions currently flattened into one. Sharing the table
     * rather than adding a second one means the menu, the confirm step, the
     * permission gating and the audit snapshot all work for both without a
     * parallel implementation to keep in sync.
     */
    decision: outcomeDecisionEnum("decision").notNull().default("accept"),

    /** Select option label. Discord truncates at 100 characters. */
    label: text("label").notNull(),
    /**
     * Shown under the label in the menu, greyed. This is where the
     * consequence goes — "full permissions, can ban members" — because the
     * menu is the last moment before the roles are applied and a label alone
     * doesn't tell a new reviewer what they're about to hand out.
     */
    description: text("description"),
    /** Optional emoji. Unicode or a custom emoji id. */
    emoji: text("emoji"),

    // Same shape as the form-level fields, so the accept path can treat a
    // form with no outcomes as a single implicit outcome and share all the
    // role-application code rather than growing a second copy of it.
    grantRoleIds: jsonb("grant_role_ids").$type<string[]>().notNull().default([]),
    removeRoleIds: jsonb("remove_role_ids").$type<string[]>().notNull().default([]),

    /** DM sent to the applicant. Falls back to the form's accept message. */
    message: text("message"),
    /** Falls back to forms.acceptedChannelId, then forms.logChannelId. */
    logChannelId: bigint("log_channel_id", { mode: "bigint" }),

    /**
     * Minimum staff level permitted to choose this outcome, as a rank against
     * permissionLevelEnum: 0 = manager (any reviewer), 1 = admin, 2 = owner.
     *
     * Stored as an integer rather than the enum so comparisons are ordered.
     * The enum is a set of names; "is manager >= admin" isn't a question you
     * can ask it without a lookup table, and getting that comparison wrong
     * here is a privilege escalation rather than a display bug.
     *
     * Default 0 keeps existing behaviour: everyone who can review can pick it.
     * Raise it on the outcomes that actually grant power.
     */
    minStaffLevel: integer("min_staff_level").notNull().default(0),

    /** Display order. Reviewers develop muscle memory; keep it stable. */
    position: integer("position").notNull().default(0),

    /**
     * Confirmation step before applying this outcome. ON by default.
     *
     * A select menu fires the moment an option is clicked — there is no
     * built-in "are you sure" — so without this a misclick silently hands
     * someone ban permissions, and the only trace is an audit line nobody
     * reads until it matters.
     *
     * The confirm is a summary of what will happen, not a yes/no prompt (see
     * bot/src/interactions/outcomeConfirm.ts). That distinction is what stops
     * it becoming reflex: a prompt carrying no information gets clicked
     * through within a day, at which point it costs a click on every review
     * and prevents nothing.
     *
     * Turning it off is possible per outcome and reasonable for genuinely
     * low-stakes ones — a "Rejected, reapply later" tag, say. It is ignored
     * for outcomes with minStaffLevel > 0: an outcome restricted to admins
     * always confirms, because that's the one where a misclick is expensive.
     */
    requiresConfirm: boolean("requires_confirm").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    formIdx: index("form_outcome_form_idx").on(t.formId),
    // Two outcomes with the same label on one form is always a mistake, and a
    // confusing one — the reviewer sees two identical buttons.
    // Per decision: an "Approved" accept and an "Approved" deny would be
    // absurd, but "Standard" appearing once in each menu is fine.
    labelUniq: uniqueIndex("form_outcome_label_uniq").on(t.formId, t.decision, t.label),
  }),
);

export const formOutcomesRelations = relations(formOutcomes, ({ one }) => ({
  form: one(forms, { fields: [formOutcomes.formId], references: [forms.id] }),
}));

/**
 * Recorded on the submission when accepted.
 *
 * `outcomeLabel` is a snapshot, deliberately duplicated rather than joined.
 * Outcomes get renamed and deleted; "accepted as Moderator on 3 June" has to
 * stay true afterwards. An audit trail that changes retroactively when someone
 * edits a form isn't an audit trail. The FK is nulled on delete, the text
 * survives.
 */
export const submissionOutcomeColumns = {
  outcomeId: text("outcome_id").references(() => formOutcomes.id, { onDelete: "set null" }),
  outcomeLabel: text("outcome_label"),
};

export interface FormOutcomeDTO {
  id: string;
  decision: "accept" | "deny";
  label: string;
  description: string | null;
  emoji: string | null;
  requiresConfirm: boolean;
  grantRoleIds: string[];
  removeRoleIds: string[];
  message: string | null;
  logChannelId: string | null;
  minStaffLevel: number;
  position: number;
}

/**
 * Outcomes are always a select menu, never a row of buttons — even when there
 * are only two, and even though a button would save a click.
 *
 * Three reasons, in ascending order of how much they matter:
 *
 * 1. The UI doesn't reshuffle. With buttons, adding a fifth outcome silently
 *    converts every review message in the guild to a different interaction.
 *    Reviewers who had muscle memory now misclick.
 *
 * 2. Descriptions are visible at decision time. A button shows a label and
 *    nothing else; a select option shows "Moderator" with "full permissions,
 *    can ban members" underneath it. For a decision that hands out power,
 *    that line is worth more than the click it costs.
 *
 * 3. Deny stops sharing a row with the accepts. This is the real one. With
 *    buttons, an irreversible action sits one misclick away from the thing
 *    you're scanning across. Separating the gesture — pick from a menu to
 *    accept, press a distinct button to deny — makes them hard to confuse.
 *
 * Deny stays a button for exactly that reason: different action, different
 * gesture.
 */
export const MAX_OUTCOMES_IN_MENU = 25;

/** permissionLevelEnum as an ordered rank. Higher wins. */
export const STAFF_RANK = { manager: 0, admin: 1, owner: 2 } as const;
export type StaffLevel = keyof typeof STAFF_RANK;

/**
 * Outcomes this reviewer may choose.
 *
 * Filtering rather than rejecting is deliberate: a button that is visible and
 * always fails trains people to believe the bot is broken, and it also leaks
 * the shape of your staff hierarchy to whoever can see the review message.
 */
export function visibleOutcomes(
  outcomes: FormOutcomeDTO[],
  reviewerLevel: StaffLevel,
): FormOutcomeDTO[] {
  const rank = STAFF_RANK[reviewerLevel];
  return outcomes
    .filter((o) => o.minStaffLevel <= rank)
    .sort((a, b) => a.position - b.position);
}

/**
 * Build the Discord select options for a reviewer.
 *
 * Returns null when there is nothing to render — either the form has no
 * outcomes (single-accept path, unchanged) or this reviewer can pick none of
 * them, in which case they should see Deny alone rather than an empty menu.
 */
export function buildOutcomeMenu(
  outcomes: FormOutcomeDTO[],
  reviewerLevel: StaffLevel,
  submissionId: string,
  decision: "accept" | "deny" = "accept",
) {
  const allowed = visibleOutcomes(outcomes, reviewerLevel);
  if (allowed.length === 0) return null;

  return {
    type: 3, // string select
    customId: `review:${decision === "deny" ? "denyoutcome" : "outcome"}:${submissionId}`,
    // Names the decision rather than the mechanism. "Choose an option" tells a
    // tired reviewer nothing about what the menu does.
    placeholder: decision === "deny" ? "Deny because…" : "Accept as…",
    minValues: 1,
    maxValues: 1,
    options: allowed.slice(0, MAX_OUTCOMES_IN_MENU).map((o) => ({
      label: o.label.slice(0, 100),
      value: o.id,
      description: o.description?.slice(0, 100) ?? undefined,
      emoji: o.emoji ? { name: o.emoji } : undefined,
    })),
  };
}

/**
 * Second guard, independent of staff level: a reviewer may not grant a role
 * at or above their own highest role.
 *
 * Discord enforces this for the bot and not for the human clicking the button
 * — without it, an admin-level reviewer whose actual Discord role sits low in
 * the hierarchy can still hand out roles above themselves. Pass the reviewer's
 * highest role position and each granted role's position.
 */
/**
 * Whether this outcome confirms before applying.
 *
 * Privileged outcomes always do, regardless of the column. Letting someone
 * disable the confirm on an owner-only outcome removes the guard exactly
 * where it's load-bearing, and there's no legitimate reason to want that.
 */
export function shouldConfirm(outcome: FormOutcomeDTO): boolean {
  return outcome.requiresConfirm || outcome.minStaffLevel > 0;
}

export function outcomeExceedsReviewer(
  grantedRolePositions: number[],
  reviewerHighestPosition: number,
): boolean {
  return grantedRolePositions.some((p) => p >= reviewerHighestPosition);
}

/** Discord's own ceiling for a string select. */
export const MAX_OUTCOMES_PER_FORM = MAX_OUTCOMES_IN_MENU;
