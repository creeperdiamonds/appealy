// shared/schema/platformBans.ts
//
// PLATFORM-level bans — us moderating our own platform.
//
// Not to be confused with appealConfigs / forms.kind = "appeal" in schema.ts,
// which is the product feature: a GUILD moderating its own members, DMing a
// banned member an appeal form and unbanning them if staff accept.
//
// Two different things that both say "ban appeal":
//   appealConfigs   guild bans a member   -> member appeals to guild staff
//   platformBans    we ban a user/guild   -> they appeal to us
//
// Guild staff can never see or touch platformBans; it lives behind /ops. The
// prefix exists precisely so nobody wires one to the other.
//
// Why reason_public and notes are separate
// ----------------------------------------
// `notes` and `evidence` let a reviewer six months later see why the ban was
// issued. `reason_public` is the only thing the banned party ever receives.
// Naming the heuristic that caught someone is a recipe for evading it on the
// next account, and a ban screen quoting an internal rule id reads as an
// accusation rather than a decision.

import {
  pgTable, pgEnum, text, bigint, boolean, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const banSubjectEnum = pgEnum("ban_subject", ["user", "guild"]);
export const platformAppealStatusEnum = pgEnum("platform_appeal_status", [
  "open", "accepted", "denied", "withdrawn",
]);

/**
 * What the person filing is actually claiming.
 *
 * An APPEAL says the ban was wrong. An APOLOGY says it was right and asks for
 * another chance anyway. They are genuinely different submissions and it is
 * worth not collapsing them: most people who want back in do not dispute what
 * they did, and an appeal form is the wrong shape for them — it makes someone
 * argue a case they do not believe in order to say the one thing they mean.
 * Reviewers get a worse signal too, since a fabricated argument reads much
 * like a real one and takes as long to disprove.
 *
 * Apologies are capped hard and for life (see maxApologiesLifetime). That is
 * the whole mechanism: the reason an apology carries weight is that there are
 * almost none of them. Grant it per-ban or refill it and it becomes another
 * form to submit, at which point it means nothing and reviewers start
 * skipping them.
 */
export const platformAppealKindEnum = pgEnum("platform_appeal_kind", ["appeal", "apology"]);

export const platformBans = pgTable(
  "platform_bans",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    subject: banSubjectEnum("subject").notNull(),
    subjectId: bigint("subject_id", { mode: "bigint" }).notNull(),

    reasonCode: text("reason_code").notNull(),
    reasonPublic: text("reason_public").notNull(),

    // --- Never leaves the server. See header. ---
    notes: text("notes"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),

    // 0n for automated bans, so the column stays notNull and reviewers filter
    // on `automated` rather than sniffing a sentinel id.
    actorId: bigint("actor_id", { mode: "bigint" }).notNull(),
    automated: boolean("automated").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }), // null = permanent

    // Revoked rows are kept. A subject's history is the main input a reviewer
    // has when the same account turns up again.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: bigint("revoked_by", { mode: "bigint" }),
    revokeReason: text("revoke_reason"),
  },
  (t) => ({
    // One live ban per subject, enforced by the database rather than by
    // application logic — two staff acting at once should not be able to
    // produce two active bans whose expiry dates disagree.
    activeUniq: uniqueIndex("platform_bans_active_uniq")
      .on(t.subject, t.subjectId).where(sql`revoked_at is null`),
    expiryIdx: index("platform_bans_expiry_idx").on(t.expiresAt),
    subjectIdx: index("platform_bans_subject_idx").on(t.subject, t.subjectId),
  }),
);

export const platformBanAppeals = pgTable(
  "platform_ban_appeals",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    banId: text("ban_id").notNull().references(() => platformBans.id, { onDelete: "cascade" }),

    // For a guild ban this is whoever filed, verified against the live OAuth
    // guilds payload at submit time — never a client-supplied role.
    appellantId: bigint("appellant_id", { mode: "bigint" }).notNull(),
    body: text("body").notNull(),

    // Defaults to "appeal" so every existing row keeps its meaning — they were
    // all appeals, and a backfill that guessed otherwise would misrepresent
    // what people actually wrote.
    kind: platformAppealKindEnum("kind").notNull().default("appeal"),

    status: platformAppealStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: bigint("decided_by", { mode: "bigint" }),
    // Shown to the appellant. Write it as if they will read it, because they will.
    decisionNote: text("decision_note"),
  },
  (t) => ({
    // One open appeal per ban. A partial unique index means the queue cannot
    // be flooded even if the rate limiter is bypassed or Redis is down.
    oneOpen: uniqueIndex("platform_ban_appeals_one_open")
      .on(t.banId).where(sql`status = 'open'`),
    triageIdx: index("platform_ban_appeals_triage_idx").on(t.status, t.createdAt),
    appellantIdx: index("platform_ban_appeals_appellant_idx").on(t.appellantId),
    // The lifetime apology count is read on every apology submission and on
    // every ban screen, and it spans all of one person's bans rather than one
    // row — so it is a lookup by appellant, not by ban.
    apologyIdx: index("platform_ban_appeals_apology_idx").on(t.appellantId, t.kind),
  }),
);

export const platformBansRelations = relations(platformBans, ({ many }) => ({
  appeals: many(platformBanAppeals),
}));
export const platformBanAppealsRelations = relations(platformBanAppeals, ({ one }) => ({
  ban: one(platformBans, { fields: [platformBanAppeals.banId], references: [platformBans.id] }),
}));

// Defined in shared/types/index.ts and re-exported here so existing importers
// are unaffected. It moved because the console imports it, and this module
// defines drizzle tables — which the browser bundle would otherwise have to
// resolve just to name a type.
//
// Imported and then re-exported, rather than `export type { X } from`: a bare
// re-export does not bind the name locally, so toPublicBan's return annotation
// below would not see it.
import type { PublicBan } from "../types/index.ts";
export type { PublicBan };

/**
 * The single serialization boundary for a ban. Every route returning ban data
 * goes through this — do not spread a row into a response body, or the first
 * time someone adds a column to `evidence` it ships to the client.
 */
export function toPublicBan(
  row: typeof platformBans.$inferSelect,
  openAppeal?: { createdAt: Date } | null,
): PublicBan {
  return {
    id: row.id,
    subject: row.subject,
    subjectId: row.subjectId.toString(),
    reasonCode: row.reasonCode,
    reasonPublic: row.reasonPublic,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    automated: row.automated,
    openAppeal: openAppeal ? { createdAt: openAppeal.createdAt.toISOString() } : null,
  };
}

/**
 * Appeal limits.
 *
 * These exist to protect reviewers from a flooded queue, not to wear down
 * appellants. One motivated person submitting fifty appeals buries every
 * genuine one behind them, and the people harmed by that are the other
 * appellants — so a cap is real protection, not an obstacle.
 *
 * But this project exists because a bot told its users "this decision is
 * final and cannot be appealed", so the limits are shaped to never become
 * that sentence:
 *
 *   - Automated bans get more attempts than reviewed ones. A ban nobody
 *     looked at is exactly the kind most likely to be wrong, and the
 *     appellant did nothing to earn a shorter rope than someone a human
 *     actually considered.
 *   - Running out of attempts pauses appeals; it does not close the case.
 *     `reopenAfterDays` is when the counter resets. A ban can always be
 *     revisited eventually, because a permanent ban with no path back is
 *     the thing this bot was written in response to.
 *   - No message anywhere says "final".
 */
export const APPEAL_RULES = {
  minLength: 40,
  maxLength: 2000,

  /** Attempts before appeals pause, for a ban a human reviewed. */
  maxAttemptsReviewed: 3,
  /**
   * Attempts for an automated ban. Higher on purpose: nobody looked at it
   * before it landed, and a heuristic misfiring on an innocent user is the
   * single most likely way this system hurts someone.
   */
  maxAttemptsAutomated: 5,

  /** Wait after a denial before the next attempt is accepted. */
  cooldownDays: 30,
  /**
   * After attempts are exhausted, appeals reopen this many days later with a
   * fresh count. Deliberately finite. "You may appeal again in six months" is
   * a different thing from "you may never appeal again", and only one of them
   * is a decision a person can live with.
   */
  reopenAfterDays: 180,

  /**
   * Apologies a person may ever file, across every ban they have had.
   *
   * Two, for life, never reset — deliberately unlike every other limit here,
   * which pause and reopen. That looks like a contradiction of this module's
   * rule that nothing is ever final, so it is worth being precise: running
   * out of apologies takes nothing away. The appeal path stays open on its own
   * schedule, and it is the path that can actually overturn a ban. An apology
   * is an extra lane offered on top, and it only works because it is scarce.
   *
   * Two rather than one because the first is often spent early and clumsily,
   * by someone who has just been banned and is not thinking well. Two rather
   * than three because by the third, "I am sorry" is a form response.
   */
  maxApologiesLifetime: 2,

  /** Guild appeals require this permission bit on the appellant. */
  manageGuild: 0x20n,
} as const;

/** Attempts allowed for a given ban. Automated bans get the longer rope. */
export function attemptsAllowed(ban: { automated: boolean }): number {
  return ban.automated ? APPEAL_RULES.maxAttemptsAutomated : APPEAL_RULES.maxAttemptsReviewed;
}

export interface ApologyEligibility {
  /** False when this ban cannot take an apology at all — see `reason`. */
  available: boolean;
  remaining: number;
  reason: "ok" | "not_a_user_ban" | "none_left";
}

/**
 * Whether this person may apologise for this ban.
 *
 * Guild bans are excluded on purpose. An apology is a personal statement and a
 * server is not a person: whoever holds Manage Server today may have had
 * nothing to do with what happened, and may not be the same account that holds
 * it next month. Letting one member spend a scarce, lifetime-limited apology
 * on behalf of an organisation — or on behalf of whoever comes after them —
 * is not a trade anybody consented to. Guild bans keep the appeal path, which
 * argues facts rather than intent and is the right instrument for them.
 *
 * `usedLifetime` counts every apology this appellant has ever filed, on any
 * ban. Scoping it per-ban would let someone accumulate bans and an allowance
 * with each one, which inverts the intent exactly.
 */
export function apologyEligibility(
  ban: { subject: "user" | "guild" },
  usedLifetime: number,
): ApologyEligibility {
  const remaining = Math.max(0, APPEAL_RULES.maxApologiesLifetime - usedLifetime);
  if (ban.subject !== "user") return { available: false, remaining, reason: "not_a_user_ban" };
  if (remaining === 0) return { available: false, remaining: 0, reason: "none_left" };
  return { available: true, remaining, reason: "ok" };
}
