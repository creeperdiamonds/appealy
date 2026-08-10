// shared/schema/bans.ts
//
// Platform-level bans and the appeal process attached to them.
//
// Two subjects, deliberately different blast radii
// -----------------------------------------------
//   user   -> the account cannot use the bot anywhere, and the dashboard is
//             replaced by the ban screen at the session layer.
//   guild  -> the server is inert. The bot ignores it and its settings are
//             locked, but the owner still signs in and manages their other
//             servers normally.
//
// This is NOT the same thing as antiRaidConfigs or Discord's own guild bans.
// Those are a guild moderating its own members. This is us moderating our
// own platform, and only staff can write to it.
//
// Why reason_public and notes are separate columns
// ------------------------------------------------
// `notes` and `evidence` exist so a reviewer six months later can see why
// the ban was issued. `reason_public` is the only thing the banned party
// ever receives. Telling someone which heuristic caught them is a recipe
// for evading it on the next account, and a ban screen that quotes an
// internal rule id reads as an accusation rather than a decision. Keep the
// serialization boundary honest: never spread a bans row into a response.
//
// Why appeals live here rather than reusing `submissions`
// -------------------------------------------------------
// Tempting, since this codebase is already a form/application system. But
// submissions are scoped to a guild and reviewed by that guild's staff, and
// a banned guild cannot host the review of its own ban. Appeals are ours.

import {
  pgTable,
  pgEnum,
  text,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const banSubjectEnum = pgEnum("ban_subject", ["user", "guild"]);

export const appealStatusEnum = pgEnum("appeal_status", [
  "open",
  "accepted",
  "denied",
  "withdrawn",
]);

export const bans = pgTable(
  "bans",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subject: banSubjectEnum("subject").notNull(),
    subjectId: bigint("subject_id", { mode: "bigint" }).notNull(), // Discord snowflake

    // Stable machine-readable code, used for metrics and for picking the
    // copy shown on the ban screen. Free text lives in reasonPublic.
    reasonCode: text("reason_code").notNull(),
    reasonPublic: text("reason_public").notNull(),

    // --- Never leaves the server. See header. ---
    notes: text("notes"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),

    // 0n for automated bans, so the column stays notNull and reviewers can
    // filter on `automated` rather than sniffing a sentinel id.
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
    activeUniq: uniqueIndex("bans_active_uniq")
      .on(t.subject, t.subjectId)
      .where(sql`revoked_at is null`),
    expiryIdx: index("bans_expiry_idx").on(t.expiresAt),
    subjectIdx: index("bans_subject_idx").on(t.subject, t.subjectId),
  }),
);

export const banAppeals = pgTable(
  "ban_appeals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    banId: text("ban_id")
      .notNull()
      .references(() => bans.id, { onDelete: "cascade" }),

    // For a guild ban this is whoever filed, and it is verified against the
    // OAuth guilds payload at submit time — never from a client-supplied
    // role or a cached permission bit.
    appellantId: bigint("appellant_id", { mode: "bigint" }).notNull(),
    body: text("body").notNull(),

    status: appealStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: bigint("decided_by", { mode: "bigint" }),
    // Shown to the appellant. Write it as if they will read it, because they will.
    decisionNote: text("decision_note"),
  },
  (t) => ({
    // One open appeal per ban. A partial unique index means the queue cannot
    // be flooded even if the rate limiter is bypassed or Redis is down.
    oneOpen: uniqueIndex("ban_appeals_one_open")
      .on(t.banId)
      .where(sql`status = 'open'`),
    triageIdx: index("ban_appeals_triage_idx").on(t.status, t.createdAt),
    appellantIdx: index("ban_appeals_appellant_idx").on(t.appellantId),
  }),
);

export const bansRelations = relations(bans, ({ many }) => ({
  appeals: many(banAppeals),
}));

export const banAppealsRelations = relations(banAppeals, ({ one }) => ({
  ban: one(bans, { fields: [banAppeals.banId], references: [bans.id] }),
}));

// ---------------------------------------------------------------------------
// Wire type
// ---------------------------------------------------------------------------

export interface PublicBan {
  id: string;
  subject: "user" | "guild";
  subjectId: string;
  reasonCode: string;
  reasonPublic: string;
  createdAt: string;
  expiresAt: string | null;
  automated: boolean;
  openAppeal: { createdAt: string } | null;
}

/**
 * The single serialization boundary for a ban. Every route that returns ban
 * data goes through this — do not spread a row into a response body, or the
 * first time someone adds a column to `evidence` it ships to the client.
 */
export function toPublicBan(
  row: typeof bans.$inferSelect,
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

export const APPEAL_RULES = {
  minLength: 40,
  maxLength: 2000,
  /** Lifetime cap per ban. Past this the decision stands. */
  maxAttempts: 3,
  /** Wait after a denial before another attempt is accepted. */
  cooldownDays: 30,
  /** Guild appeals require this permission bit on the appellant. */
  manageGuild: 0x20n,
} as const;

import { sql } from "drizzle-orm";
