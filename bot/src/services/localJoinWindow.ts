// bot/src/services/localJoinWindow.ts
//
// Joins this process has seen for a guild, inside a rolling window.
//
// A LEAF MODULE ON PURPOSE: it imports nothing.
//
// This logic lived in antiRaidService.ts, which imports the db client, which
// imports env.ts, which calls resolveDeployment() at module load and reads
// Deno.env. That makes a pure counter untestable without granting the whole
// test run ambient environment access — and CI runs `deno test --allow-read`
// with no --allow-env, deliberately. Every bot test that loads today imports
// a leaf utility for exactly this reason; this is now one of them.
//
// What it is for:
//
//   1. A quiet guild costs ZERO Redis commands. Redis is only consulted once
//      this process has seen enough joins to make the answer matter.
//   2. When Redis cannot answer, raid detection has something real to fall
//      back to rather than reading an outage as "nothing is happening".
//
// Per-process by nature: with several shards each holds a fraction of the
// joins, which is why it gates rather than decides.

/**
 * Joins this process has seen for a guild inside the window.
 *
 * Exists so the common case — a guild nobody is raiding — costs no Redis at
 * all, and so a Redis outage still leaves something to reason from. It is
 * per-process by nature: with several shards each holds a fraction, which is
 * why it gates rather than decides.
 *
 * Timestamps are pruned on read, and a guild whose entries all expire drops
 * out of the map entirely, so this cannot grow without bound on a bot in
 * many servers.
 */
const localJoins = new Map<bigint, number[]>();

export function recordLocalJoin(guildId: bigint, now: number, windowSeconds: number): number {
  const cutoff = now - windowSeconds * 1000;
  // >= , not >. The Redis path this stands in for counts with
  //   ZCOUNT key windowStart now
  // which is inclusive of both endpoints, and its eviction deliberately stops
  // one millisecond below windowStart (ZREMRANGEBYSCORE 0 windowStart - 1) so
  // that a join landing exactly on the boundary is kept. An exclusive
  // comparison here made the in-process count one lower than Redis's at that
  // edge — and since this count is only consulted when Redis cannot answer,
  // the disagreement would only ever appear when there was nothing to compare
  // it against.
  const seen = (localJoins.get(guildId) ?? []).filter((t) => t >= cutoff);
  seen.push(now);
  if (seen.length === 0) localJoins.delete(guildId);
  else localJoins.set(guildId, seen);
  return seen.length;
}

/** Test seam: drops the in-process counts. */
export function resetLocalJoins(): void {
  localJoins.clear();
}
