// api/src/utils/roleCapPayload.ts
//
// Shared by the form routes and the outcome routes, which enforce the same
// `rolesPerRuleType` cap against the same rule names. Outcomes carry their own
// grantRoleIds/removeRoleIds, so without a check there the cap on a form is
// avoidable by moving the roles into an outcome instead.

import {
  FORM_ROLE_RULE_LABELS,
  type RoleCapViolation,
} from "../../../shared/schema/pricing.ts";

/**
 * Body for a `rolesPerRuleType` violation.
 *
 * Sent with 400, NOT 429, even though it is a plan limit. web/src/lib/api.ts
 * retries any 429 once after `Retry-After ?? 2` seconds — right for a
 * throughput limit, wrong for this one. A role cap is a permanent property of
 * the submitted body, so the retry cannot succeed; all it buys is a silent
 * two-second pause and a duplicate write attempt before the admin is told
 * anything.
 *
 * Names the offending fields by their picker labels rather than their column
 * names. "You are over a limit" without saying which of ten role pickers is
 * over it costs the admin more time than no message would — and saying
 * "grantRoleIds" names the wrong thing precisely.
 */
export function roleCapPayload(violations: RoleCapViolation[]) {
  const limit = violations[0].limit;
  const names = violations.map((v) => FORM_ROLE_RULE_LABELS[v.rule] ?? v.rule);
  return {
    error: "role_cap_exceeded",
    detail:
      `Your plan allows ${limit} role${limit === 1 ? "" : "s"} per rule. ` +
      `${names.join(", ")} ${violations.length === 1 ? "exceeds" : "exceed"} that. ` +
      `Raise your limit from the billing page, or remove some roles.`,
    violations,
  };
}
