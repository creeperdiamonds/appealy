// shared/services/appealTriggers.ts
//
// Decides when a timeout or a restriction role deserves an appeal notice.
//
// Pure, so the rules can be asserted without a gateway or a database; the
// bot's guildMemberUpdate handler does the I/O around them. Discord sends that
// event for nicknames, avatars and every role change, so the one rule that
// matters most is the one these exist to keep: never tell the same member
// about the same punishment twice.

/**
 * Which restriction roles need a notice now, and which past notices to forget.
 *
 * A notice for a role the member no longer holds is forgotten, so the role
 * being handed out again later counts as a new punishment with a new notice.
 */
export function diffRestrictionNotices(
  memberRoleIds: readonly string[],
  restrictionRoleIds: readonly string[],
  noticed: readonly string[],
): { notify: string[]; clear: string[] } {
  const restricted = new Set(restrictionRoleIds);
  const held = new Set(memberRoleIds.filter((r) => restricted.has(r)));
  const already = new Set(noticed);
  return {
    notify: [...held].filter((r) => !already.has(r)),
    clear: [...already].filter((r) => !held.has(r)),
  };
}

/**
 * The notice key for a member's current timeout, or null when it doesn't
 * warrant one: no timeout, one already over, or one shorter than the guild's
 * threshold — a ten-minute timeout ends before anyone could read an appeal.
 *
 * Measured from now, because the event carries only the end time. It fires as
 * the timeout is applied, so what's left is effectively its whole length.
 *
 * The key is the end time itself, so a new timeout — an extension included —
 * is a new punishment with its own notice.
 */
export function timeoutNoticeKey(
  untilMs: number | null | undefined,
  nowMs: number,
  minSeconds: number,
): string | null {
  if (!untilMs || untilMs <= nowMs) return null;
  if (untilMs - nowMs < minSeconds * 1000) return null;
  return String(untilMs);
}
