// bot/src/services/raidAccountAge.ts
//
// Whether an account is new enough to count as part of a raid. A leaf module
// for the same reason as localJoinWindow.ts: CI's tests can't import anything
// that loads env.ts.

const DISCORD_EPOCH_MS = 1_420_070_400_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When an account was created, which Discord encodes in its user ID. */
export function accountCreatedAt(userId: bigint): number {
  return Number(userId >> 22n) + DISCORD_EPOCH_MS;
}

/** True for every account when `newAccountDays` is 0, the "no filter" value. */
export function countsForRaid(userId: bigint, newAccountDays: number, now = Date.now()): boolean {
  if (newAccountDays <= 0) return true;
  return now - accountCreatedAt(userId) < newAccountDays * DAY_MS;
}
