// shared/schema/reviewers.ts
//
// The per-form reviewer whitelist rule, kept pure and in one place.
//
// It lives in shared/ rather than in the bot because the rule is a policy
// decision, not a Discord mechanic, and policy that exists in two copies
// eventually exists in two versions. Today only the bot enforces it — guild
// submissions are decided by the buttons on the review post and there is no
// API route that accepts or denies one. If that changes, the new caller
// imports this rather than reimplementing "is this person on the list".
//
// No imports on purpose: same reasoning as shared/schema/pricing.ts. The bot
// runs on Deno and the API on Node, and a shared module that reaches for
// drizzle or a DB client stops being importable from one of them.

/** The subset of a form this rule reads. */
export interface ReviewerWhitelistConfig {
  reviewerWhitelistEnabled: boolean;
  reviewerUserIds: string[];
  reviewerRoleIds: string[];
}

/**
 * Whether a whitelist is in force.
 *
 * Enabled-but-empty is deliberately treated as "not in force". The API
 * refuses to save that combination, so it should be unreachable — but if a
 * row ever reaches it (a hand-written UPDATE, a restored backup, an import
 * from a server whose roles all failed to resolve), the safe reading is that
 * the form falls back to normal staff permissions. The alternative is a form
 * no one on earth can review, discoverable only when an appeal goes stale.
 */
export function whitelistActive(form: ReviewerWhitelistConfig): boolean {
  return (
    form.reviewerWhitelistEnabled &&
    (form.reviewerUserIds.length > 0 || form.reviewerRoleIds.length > 0)
  );
}

/**
 * Whether this member is on the form's whitelist.
 *
 * Ids are compared as strings throughout. The bot holds them as bigint and
 * the database as bigint, but the whitelist columns are jsonb string arrays
 * for the same reason every other id list in this schema is: JSON has no
 * 64-bit integer, and a snowflake that round-trips through a JSON number
 * comes back subtly wrong.
 */
export function isWhitelistedReviewer(
  form: ReviewerWhitelistConfig,
  userId: string,
  memberRoleIds: string[],
): boolean {
  if (form.reviewerUserIds.includes(userId)) return true;
  return form.reviewerRoleIds.some((roleId) => memberRoleIds.includes(roleId));
}
