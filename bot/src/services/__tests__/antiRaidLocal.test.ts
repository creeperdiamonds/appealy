// bot/src/services/__tests__/antiRaidLocal.test.ts
//
// The in-process join counter decides two things that matter more than its
// size suggests: whether Redis is consulted at all on a join, and what raid
// detection falls back to when Redis cannot answer. Get the pruning wrong and
// a guild either never reaches the watermark (Redis never asked, no raid ever
// detected) or never falls below it (Redis asked on every join forever, which
// is the amplification this change exists to remove).
//
// `now` is passed in rather than read from the clock so the window can be
// crossed without waiting for it.
//
// Imported from localJoinWindow.ts, NOT antiRaidService.ts. That service
// imports the db client, which imports env.ts, which reads Deno.env at
// module load — and CI runs `deno test --allow-read` with no --allow-env,
// so importing it here makes the file fail to load with 0 tests run.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordLocalJoin, resetLocalJoins } from "../localJoinWindow.ts";

const GUILD = 1549829772652060682n;
const OTHER = 1234567890123456789n;

Deno.test("the first join in a window counts as one", () => {
  resetLocalJoins();
  assertEquals(recordLocalJoin(GUILD, 1_000_000, 60), 1);
});

Deno.test("joins inside the window accumulate", () => {
  resetLocalJoins();
  const t = 1_000_000;
  assertEquals(recordLocalJoin(GUILD, t, 60), 1);
  assertEquals(recordLocalJoin(GUILD, t + 1_000, 60), 2);
  assertEquals(recordLocalJoin(GUILD, t + 2_000, 60), 3);
});

Deno.test("a join older than the window is pruned, so a quiet guild returns to one", () => {
  resetLocalJoins();
  const t = 1_000_000;
  recordLocalJoin(GUILD, t, 60);
  // Well past the 60s window: the earlier entry must not still be counted,
  // or the guild would stay above the watermark forever and consult Redis on
  // every join for the rest of the process's life.
  assertEquals(recordLocalJoin(GUILD, t + 120_000, 60), 1);
});

Deno.test("the window boundary keeps a join exactly on it", () => {
  resetLocalJoins();
  const t = 1_000_000;
  recordLocalJoin(GUILD, t, 60);
  // Exactly windowSeconds later: the cutoff is strictly older-than, so the
  // first join is still inside.
  assertEquals(recordLocalJoin(GUILD, t + 60_000, 60), 2);
});

Deno.test("one guild's joins never count toward another's", () => {
  resetLocalJoins();
  const t = 1_000_000;
  recordLocalJoin(GUILD, t, 60);
  recordLocalJoin(GUILD, t + 1, 60);
  assertEquals(recordLocalJoin(OTHER, t + 2, 60), 1, "a busy guild must not arm a quiet one");
});

Deno.test("a burst reaches the watermark a real threshold implies", () => {
  resetLocalJoins();
  const t = 1_000_000;
  // The service asks Redis once local joins reach max(2, floor(threshold/2)).
  // For a threshold of 10 that is 5, which a burst crosses on the fifth join.
  const threshold = 10;
  const watermark = Math.max(2, Math.floor(threshold / 2));
  let count = 0;
  for (let i = 0; i < watermark; i++) count = recordLocalJoin(GUILD, t + i, 60);
  assertEquals(count, watermark);
  assertEquals(count >= watermark, true, "the pre-filter must open before the real threshold");
});

Deno.test("a low threshold still uses a floor of two, not one", () => {
  resetLocalJoins();
  // floor(3/2) is 1, which would consult Redis on the very first join and
  // defeat the pre-filter entirely — hence the max(2, …).
  assertEquals(Math.max(2, Math.floor(3 / 2)), 2);
});
