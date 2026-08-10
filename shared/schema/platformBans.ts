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
  }),
);

export const platformBansRelations = relations(platformBans, ({ many }) => ({
  appeals: many(platformBanAppeals),
}));
export const platformBanAppealsRelations = relations(platformBanAppeals, ({ one }) => ({
  ban: one(platformBans, { fields: [platformBanAppeals.banId], references: [platformBans.id] }),
}));

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
