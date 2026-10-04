// bot/src/services/appealSuppression.ts
//
// "?ban noappeal": a ban that must not send the appeal button.
//
// The appeal DM isn't sent by the command. It's sent by events/guildBanAdd.ts
// when Discord reports the ban, which is how bans from Discord's own menu
// get theirs too. So the command leaves a note here just before banning, and
// the event handler checks it. Held in memory, briefly: the event arrives
// within seconds on the same process, and a note that outlived its ban would
// silence the next, unrelated one.

const TTL_MS = 2 * 60_000;
const notes = new Map<string, number>();

const key = (guildId: bigint, userId: bigint) => `${guildId}:${userId}`;

/** Call just before banning, so the ban that follows sends no appeal button. */
export function suppressNextAppeal(guildId: bigint, userId: bigint): void {
  const now = Date.now();
  for (const [k, at] of notes) if (now - at > TTL_MS) notes.delete(k);
  notes.set(key(guildId, userId), now);
}

/** True, once, when this ban was made with "noappeal". */
export function takeAppealSuppression(guildId: bigint, userId: bigint): boolean {
  const k = key(guildId, userId);
  const at = notes.get(k);
  if (at === undefined) return false;
  notes.delete(k);
  return Date.now() - at <= TTL_MS;
}

/** Undo the note when the ban itself failed. */
export function clearAppealSuppression(guildId: bigint, userId: bigint): void {
  notes.delete(key(guildId, userId));
}
