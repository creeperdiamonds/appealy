// shared/schema/gating.ts
// Pure, side-effect-free evaluation of the Advanced Rules & Gating Engine.
// Takes plain data in, returns a decision. No Discord or DB calls here —
// callers (bot interaction handler, API preview endpoint) fetch the inputs
// and pass them in, which keeps this testable and reusable.

import type { GateCheckResult, Snowflake } from "../types/index.ts";

export type MatchMode = "has_all" | "has_any";

export interface GateInput {
  formActive: boolean;
  memberRoleIds: Snowflake[];
  requiredRoleIds: Snowflake[];
  /** "has_all": applicant must hold EVERY listed required role.
   * "has_any": applicant must hold AT LEAST ONE listed required role. */
  requiredRolesMatchMode: MatchMode;
  blacklistedRoleIds: Snowflake[];
  /** "has_all": applicant is blocked only if they hold EVERY listed
   * blacklisted role. "has_any": blocked if they hold AT LEAST ONE. */
  blacklistedRolesMatchMode: MatchMode;
  cooldownSeconds: number;
  lastSubmissionAt: Date | null;
  hasPendingSubmission: boolean;
  allowMultiplePending: boolean;
  totalSubmissionCount: number;
  maxTotalSubmissions: number | null;
  submissionsInWindow: number;
  maxSubmissionsInWindow: number | null;
  /** Set when a staff member has granted this applicant an active
   * /reset-cooldown override for this form (see gateOverrides table).
   * Bypasses ONLY the cooldown and standing-limit checks below — role
   * gating (required/blacklisted) and form-active/pending-exists checks
   * are never bypassable, since those reflect current eligibility rather
   * than a one-time throughput restriction. */
  hasActiveOverride?: boolean;
  now?: Date;
}

function matchesRoleSet(
  memberRoleIds: Snowflake[],
  listedRoleIds: Snowflake[],
  mode: MatchMode,
): boolean {
  if (listedRoleIds.length === 0) return false;
  return mode === "has_all"
    ? listedRoleIds.every((r) => memberRoleIds.includes(r))
    : listedRoleIds.some((r) => memberRoleIds.includes(r));
}

export function evaluateGate(input: GateInput): GateCheckResult {
  const now = input.now ?? new Date();

  if (!input.formActive) {
    return { allowed: false, reason: "form_inactive" };
  }

  if (input.requiredRoleIds.length > 0) {
    const meetsRequired = matchesRoleSet(
      input.memberRoleIds,
      input.requiredRoleIds,
      input.requiredRolesMatchMode,
    );
    if (!meetsRequired) {
      return { allowed: false, reason: "missing_required_role" };
    }
  }

  if (input.blacklistedRoleIds.length > 0) {
    const isBlacklisted = matchesRoleSet(
      input.memberRoleIds,
      input.blacklistedRoleIds,
      input.blacklistedRolesMatchMode,
    );
    if (isBlacklisted) {
      return { allowed: false, reason: "has_blacklisted_role" };
    }
  }

  if (!input.allowMultiplePending && input.hasPendingSubmission) {
    return { allowed: false, reason: "pending_exists" };
  }

  // The override, if active, bypasses only the two throughput checks below
  // — cooldown and standing submission limits — never eligibility checks
  // above (role gates, pending-exists, form-active).
  if (!input.hasActiveOverride) {
    if (input.cooldownSeconds > 0 && input.lastSubmissionAt) {
      const expiresAt = new Date(
        input.lastSubmissionAt.getTime() + input.cooldownSeconds * 1000,
      );
      if (expiresAt > now) {
        return {
          allowed: false,
          reason: "cooldown_active",
          cooldownExpiresAt: expiresAt.toISOString(),
        };
      }
    }

    if (
      input.maxTotalSubmissions !== null &&
      input.totalSubmissionCount >= input.maxTotalSubmissions
    ) {
      return { allowed: false, reason: "max_total_reached" };
    }

    if (
      input.maxSubmissionsInWindow !== null &&
      input.submissionsInWindow >= input.maxSubmissionsInWindow
    ) {
      return { allowed: false, reason: "max_window_reached" };
    }
  }

  return { allowed: true };
}

export function gateReasonToMessage(result: GateCheckResult): string {
  switch (result.reason) {
    case "missing_required_role":
      return "You don't have the required role to apply for this form.";
    case "has_blacklisted_role":
      return "You are not eligible to apply for this form.";
    case "cooldown_active": {
      const ts = result.cooldownExpiresAt
        ? `<t:${Math.floor(new Date(result.cooldownExpiresAt).getTime() / 1000)}:R>`
        : "later";
      return `You're on cooldown for this form. You can re-apply ${ts}.`;
    }
    case "max_total_reached":
      return "This form has reached its maximum number of submissions and is closed.";
    case "max_window_reached":
      return "This form has reached its submission limit for the current period. Try again later.";
    case "pending_exists":
      return "You already have a pending application for this form.";
    case "form_inactive":
      return "This form is not currently accepting applications.";
    default:
      return "You are not eligible to apply right now.";
  }
}
