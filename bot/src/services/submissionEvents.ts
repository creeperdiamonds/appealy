// bot/src/services/submissionEvents.ts
//
// Records what happened to an application, in order.
//
// The submissions row answers "where does this stand" — current status, who
// reviewed it, which outcome. Every change overwrites the last, so it can
// never answer "what happened to it". That is what this is for: an owner
// asking why an application they remember as pending is now denied, and by
// whom.
//
// WHY IT SWALLOWS ITS OWN FAILURES
//
// An audit write must never take down the action it describes. Accepting an
// application grants roles, sends a DM and unbans a member; if logging that
// threw, the reviewer would see an error for work that had already happened,
// and would reasonably do it again. A missing line in a history is a much
// smaller problem than a decision applied twice.
//
// So every failure here is logged and dropped. The log line is deliberately
// loud — a history with silent holes is worse than one that admits them.
//
// IDS ONLY
//
// No username, no avatar. See the table's own comment in
// shared/schema/schema.ts: storing profile data here would outgrow what
// site/privacy.html promises, so names are resolved when the page is read.

import { db, schema } from "../db/client.ts";
import { logger } from "../utils/logger.ts";

/**
 * What happened. Extend freely — `action` is a varchar precisely so a new
 * kind of event does not need a migration before the feature can ship.
 *
 *   created      the applicant submitted it
 *   accepted     a reviewer accepted it (detail carries the outcome label)
 *   denied       a reviewer denied it (detail carries the reason)
 *   withdrawn    pulled back from the dashboard
 *   auto_denied  the applicant left the server; nobody pressed anything
 */
export type SubmissionAction =
  | "created"
  | "accepted"
  | "denied"
  | "withdrawn"
  | "auto_denied";

export interface RecordEventArgs {
  guildId: bigint;
  submissionId: string;
  /** Null for a system action. Not a placeholder — see the table comment. */
  actorId: bigint | null;
  action: SubmissionAction;
  detail?: Record<string, unknown>;
}

export async function recordSubmissionEvent(args: RecordEventArgs): Promise<void> {
  try {
    await db.insert(schema.submissionEvents).values({
      guildId: args.guildId,
      submissionId: args.submissionId,
      actorId: args.actorId,
      action: args.action,
      detail: args.detail ?? null,
    });
  } catch (err) {
    logger.error("Failed to record a submission event; the history will have a hole", {
      submissionId: args.submissionId,
      action: args.action,
      error: String(err),
    });
  }
}
