// shared/services/userDataDeletion.ts
//
// Deleting one person's data, when they ask. site/privacy.html sends those
// requests to an email address, and they were carried out by hand.
//
// WHY THIS IS A LIST AND NOT A FUNCTION THAT "DELETES THE USER"
//
// A deletion is only as complete as the list of places someone's ID is kept.
// The failure to avoid is the one Double Counter was caught on in October
// 2026: its delete command worked on the tables someone remembered, and a
// whole product's worth of rows (every Doogle user's email and ID) was never
// touched. So every column in the schema that holds a Discord user ID is
// named below with what happens to it and why, and
// __tests__/userDataDeletion.test.ts fails when a column is added that this
// list doesn't mention. Adding a table that stores people means deciding here
// what deleting them does to it.
//
// WHAT HAPPENS TO EACH KIND OF ROW
//
//   delete     Rows ABOUT the person: their applications (answers, history,
//              votes on them and follow-ups go with them, by cascade), their
//              tickets, entries, votes, verification attempts, sessions.
//   anonymize  The person as a member of STAFF, on rows that are someone
//              else's: who reviewed an application, who closed a ticket, who
//              made a poll. The row belongs to the server and to the other
//              person, so it stays, and the ID is replaced with 0, which no
//              Discord account has. Null is not used, because a null reviewer
//              or actor already means something (not reviewed yet, or done by
//              the system), and the record would then say something untrue.
//   unlist     The ID inside a JSON list: a form's reviewers, a giveaway's
//              winners. Removed from the list; the rest stays.
//   keep       Kept on purpose, with the reason. Each one is either needed to
//              do something the person would want done (a temporary ban has to
//              be lifted when it ends), or Appealy's own abuse record.
//
// Nothing here touches Discord itself, Redis (which expires within the hour)
// or the logs (which Cloud Logging deletes after 30 days).

import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema/schema.ts";
import { platformBanAppeals, platformBans } from "../schema/platformBans.ts";

/** Stands in for a deleted person on rows that stay. No Discord account has it. */
export const DELETED_USER_ID = 0n;

export type DeletionAction = "delete" | "anonymize" | "unlist" | "keep";

export interface DeletionRule {
  table: PgTable;
  column: PgColumn;
  action: DeletionAction;
  /** Narrows which rows the rule covers, when a column means a user only sometimes. */
  where?: SQL;
  why: string;
}

export const USER_DATA_RULES: DeletionRule[] = [
  // ---- Rows about the person ----
  {
    table: schema.submissions, column: schema.submissions.applicantId, action: "delete",
    why: "Their applications. Answers, history, votes and follow-ups are deleted with them (cascade).",
  },
  { table: schema.dmApplicationProgress, column: schema.dmApplicationProgress.applicantId, action: "delete", why: "An application they're partway through by DM." },
  { table: schema.gateOverrides, column: schema.gateOverrides.applicantId, action: "delete", why: "A pass letting them apply again early." },
  { table: schema.tickets, column: schema.tickets.openerId, action: "delete", why: "Tickets they opened, with their rating." },
  { table: schema.pollVotes, column: schema.pollVotes.userId, action: "delete", why: "Their poll votes." },
  { table: schema.giveawayEntries, column: schema.giveawayEntries.userId, action: "delete", why: "Their giveaway entries." },
  { table: schema.verificationAttempts, column: schema.verificationAttempts.userId, action: "delete", why: "Their verification attempts." },
  { table: schema.raidActions, column: schema.raidActions.userId, action: "delete", why: "What a raid lockdown did to them." },
  { table: schema.appealNotices, column: schema.appealNotices.userId, action: "delete", why: "Appeal notices sent to them." },
  { table: schema.feedback, column: schema.feedback.authorId, action: "delete", why: "Feedback they wrote." },
  { table: schema.feedbackPrompts, column: schema.feedbackPrompts.userId, action: "delete", why: "Feedback prompts shown to them." },
  { table: schema.sessions, column: schema.sessions.userId, action: "delete", why: "Their dashboard logins." },
  { table: schema.staffPermissions, column: schema.staffPermissions.userId, action: "delete", why: "Staff access given to them personally." },
  { table: schema.submissionVotes, column: schema.submissionVotes.voterId, action: "delete", why: "Votes they cast on other people's applications." },
  {
    table: schema.scheduledJobs, column: schema.scheduledJobs.subjectId, action: "delete",
    where: eq(schema.scheduledJobs.kind, "kick_unverified"),
    why: "A pending kick for not verifying. Other kinds of job use this column for a poll or giveaway, not a person.",
  },
  { table: platformBanAppeals, column: platformBanAppeals.appellantId, action: "delete", why: "Appeals they sent against an Appealy ban." },

  // ---- The person as staff, on rows that belong to someone else ----
  { table: schema.submissions, column: schema.submissions.reviewerId, action: "anonymize", why: "Applications they reviewed." },
  { table: schema.submissionEvents, column: schema.submissionEvents.actorId, action: "anonymize", why: "Things they did to applications." },
  { table: schema.submissionFollowups, column: schema.submissionFollowups.askerId, action: "anonymize", why: "Questions they asked applicants. The applicant's answer stays." },
  { table: schema.gateOverrides, column: schema.gateOverrides.grantedBy, action: "anonymize", why: "Passes they gave other people." },
  { table: schema.forms, column: schema.forms.gateResetBy, action: "anonymize", why: "Cooldown resets they did." },
  { table: schema.tickets, column: schema.tickets.claimedBy, action: "anonymize", why: "Tickets they claimed." },
  { table: schema.tickets, column: schema.tickets.closedBy, action: "anonymize", why: "Tickets they closed." },
  { table: schema.polls, column: schema.polls.createdBy, action: "anonymize", why: "Polls they made. Other people voted in them." },
  { table: schema.giveaways, column: schema.giveaways.hostId, action: "anonymize", why: "Giveaways they hosted. Other people entered them." },
  { table: schema.quickResponses, column: schema.quickResponses.createdBy, action: "anonymize", why: "Saved replies they wrote. The server still uses them." },
  { table: schema.raidLockdowns, column: schema.raidLockdowns.clearedBy, action: "anonymize", why: "Raid lockdowns they ended." },
  { table: schema.dashboardAuditLogs, column: schema.dashboardAuditLogs.userId, action: "anonymize", why: "Dashboard changes they made. The server keeps the record of what changed." },
  { table: platformBans, column: platformBans.revokedBy, action: "anonymize", why: "Appealy bans they lifted (Appealy's own staff)." },
  { table: platformBanAppeals, column: platformBanAppeals.decidedBy, action: "anonymize", why: "Appeals they decided (Appealy's own staff)." },

  // ---- Inside JSON lists ----
  { table: schema.forms, column: schema.forms.reviewerUserIds, action: "unlist", why: "Forms they could review." },
  { table: schema.giveaways, column: schema.giveaways.winnerIds, action: "unlist", why: "Giveaways they won." },

  // ---- Kept, and why ----
  {
    table: schema.tempBans, column: schema.tempBans.userId, action: "keep",
    why: "A temporary ban on them. This row is what lifts it when it ends; deleting it would make the ban permanent. It is deleted when the ban ends.",
  },
  {
    table: schema.tempBans, column: schema.tempBans.bannedBy, action: "keep",
    why: "Who gave a temporary ban. Deleted with the row when the ban ends.",
  },
  {
    table: platformBans, column: platformBans.subjectId, action: "keep",
    why: "An Appealy ban on them for abuse. Deleting it would let them back in by asking.",
  },
  {
    table: platformBans, column: platformBans.actorId, action: "keep",
    why: "Who placed an Appealy ban: Appealy's own staff, needed to answer an appeal.",
  },
  {
    table: schema.guilds, column: schema.guilds.ownerId, action: "keep",
    why: "Who owns a server. Copied from Discord, updated when ownership changes, and needed to run the server's dashboard.",
  },
];

export interface DeletionLine {
  table: string;
  column: string;
  action: DeletionAction;
  rows: number;
  why: string;
}

const tableName = (t: PgTable) => (t as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")];

function matches(rule: DeletionRule, userId: bigint): SQL {
  const own = rule.action === "unlist"
    ? sql`${rule.column} @> ${JSON.stringify([userId.toString()])}::jsonb`
    : eq(rule.column, userId);
  return rule.where ? and(own, rule.where)! : own;
}

type Db = PostgresJsDatabase<Record<string, unknown>>;

/**
 * What a deletion would do, without changing anything. Only reads, so it can
 * run against a read-only connection.
 */
export async function planUserDeletion(db: Db, userId: bigint): Promise<DeletionLine[]> {
  const lines: DeletionLine[] = [];
  for (const rule of USER_DATA_RULES) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(rule.table)
      .where(matches(rule, userId));
    lines.push({ table: tableName(rule.table), column: rule.column.name, action: rule.action, rows: n, why: rule.why });
  }
  return lines;
}

/**
 * Does it, in one transaction: everything or nothing. Anonymizing runs before
 * deleting, so a row that is about to go anyway isn't touched twice for
 * nothing; the counts are the rows each step changed.
 */
export async function deleteUserData(db: Db, userId: bigint): Promise<DeletionLine[]> {
  if (userId <= 0n) throw new Error("Not a Discord user ID");
  const order: DeletionAction[] = ["anonymize", "unlist", "delete", "keep"];
  const rules = [...USER_DATA_RULES].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  return await db.transaction(async (tx) => {
    const lines: DeletionLine[] = [];
    for (const rule of rules) {
      const where = matches(rule, userId);
      let rows: number;
      if (rule.action === "keep") {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(rule.table).where(where);
        rows = n;
      } else if (rule.action === "delete") {
        rows = (await tx.delete(rule.table).where(where).returning({ one: sql`1` })).length;
      } else if (rule.action === "anonymize") {
        rows = (await tx.update(rule.table).set({ [columnKey(rule)]: DELETED_USER_ID })
          .where(where).returning({ one: sql`1` })).length;
      } else {
        rows = (await tx.update(rule.table)
          .set({ [columnKey(rule)]: sql`${rule.column} - ${userId.toString()}` })
          .where(where).returning({ one: sql`1` })).length;
      }
      lines.push({ table: tableName(rule.table), column: rule.column.name, action: rule.action, rows, why: rule.why });
    }
    return lines;
  });
}

/** The property name drizzle uses for a column in .set(), e.g. reviewerId for reviewer_id. */
function columnKey(rule: DeletionRule): string {
  const columns = rule.table as unknown as Record<string, unknown>;
  const key = Object.keys(columns).find((k) => columns[k] === rule.column);
  if (!key) throw new Error(`Column ${rule.column.name} isn't on its table`);
  return key;
}
