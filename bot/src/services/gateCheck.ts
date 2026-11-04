// bot/src/services/gateCheck.ts
//
// The one place that gathers a form's gating inputs from the database and
// asks shared/schema/gating.ts for a decision. The panel button / /apply
// (interactions/buttons/panelOpen.ts), the DM flow and web ban appeals
// (services/dmApplicationService.ts, services/webAppeal.ts) all call this.
//
// It used to be two copies, and they drifted: the DM copy hardcoded a window
// count of zero, so a form's "max N per period" limit was silently never
// enforced for DM forms or web appeals. One function, one behaviour.

import { and, desc, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { countRows } from "../db/count.ts";
import { evaluateGate, gateCountingFrom } from "../../../shared/schema/gating.ts";
import type { GateCheckResult } from "../../../shared/types/index.ts";

type Form = typeof schema.forms.$inferSelect;
/** A drizzle transaction, typed off db.transaction so this needs no driver import. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function checkApplicationGate(
  form: Form,
  applicantId: bigint,
  memberRoleIds: bigint[],
): Promise<GateCheckResult> {
  // A "reset for everyone" (forms.gateResetAt) drops older submissions from
  // the cooldown and limit counts below. Not from the pending count.
  const countFrom = gateCountingFrom(form.gateResetAt);
  const sinceReset = countFrom ? gte(schema.submissions.createdAt, countFrom) : undefined;
  const ofApplicant = and(eq(schema.submissions.formId, form.id), eq(schema.submissions.applicantId, applicantId));

  // Independent reads, run together. The panel and /apply paths end in a
  // modal, which has to be Discord's FIRST response, so they cannot defer:
  // five sequential round trips on a cold database could eat the whole
  // three-second window.
  const [[lastSubmission], pendingCount, totalCount, windowCount, override] = await Promise.all([
    db
      .select()
      .from(schema.submissions)
      .where(and(ofApplicant, sinceReset))
      .orderBy(desc(schema.submissions.createdAt))
      .limit(1),
    countRows(schema.submissions, and(ofApplicant, eq(schema.submissions.status, "pending"))),
    countRows(schema.submissions, and(ofApplicant, sinceReset)),
    // Form-wide, not per applicant: "this form has reached its submission
    // limit for the current period".
    form.maxSubmissionsWindowSeconds && form.maxSubmissionsInWindow
      ? countRows(
          schema.submissions,
          and(
            eq(schema.submissions.formId, form.id),
            gte(
              schema.submissions.createdAt,
              gateCountingFrom(form.gateResetAt, new Date(Date.now() - form.maxSubmissionsWindowSeconds * 1000))!,
            ),
          ),
        )
      : Promise.resolve(0),
    db.query.gateOverrides.findFirst({
      where: and(eq(schema.gateOverrides.formId, form.id), eq(schema.gateOverrides.applicantId, applicantId)),
    }),
  ]);
  const hasActiveOverride = Boolean(override && (!override.expiresAt || override.expiresAt > new Date()));

  return evaluateGate({
    formActive: form.active,
    memberRoleIds: memberRoleIds.map(String),
    requiredRoleIds: form.requiredRoleIds,
    requiredRolesMatchMode: form.requiredRolesMatchMode,
    blacklistedRoleIds: form.blacklistedRoleIds,
    blacklistedRolesMatchMode: form.blacklistedRolesMatchMode,
    cooldownSeconds: form.cooldownSeconds,
    lastSubmissionAt: lastSubmission?.createdAt ?? null,
    hasPendingSubmission: pendingCount > 0,
    allowMultiplePending: form.allowMultiplePending,
    totalSubmissionCount: totalCount,
    maxTotalSubmissions: form.maxTotalSubmissions,
    submissionsInWindow: windowCount,
    maxSubmissionsInWindow: form.maxSubmissionsInWindow,
    hasActiveOverride,
  });
}

/**
 * Uses up a /reset-cooldown override once its applicant has actually
 * applied. The override is a ONE-TIME pass; without this it lasted forever
 * (unless staff set expires_in_hours), so that person skipped the cooldown
 * and limits on that form for good. Called inside the transaction that
 * inserts the submission, so the pass and the application land together.
 * The row has no foreign key to the submission, so this cannot hit the
 * deadlock described in formSubmit.ts.
 */
export async function consumeGateOverride(tx: Tx, formId: string, applicantId: bigint): Promise<void> {
  await tx
    .delete(schema.gateOverrides)
    .where(and(eq(schema.gateOverrides.formId, formId), eq(schema.gateOverrides.applicantId, applicantId)));
}
