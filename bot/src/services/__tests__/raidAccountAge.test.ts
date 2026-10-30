// bot/src/services/__tests__/raidAccountAge.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { accountCreatedAt, countsForRaid } from "../raidAccountAge.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** A user ID for an account created `days` before NOW. */
function idAged(days: number): bigint {
  return BigInt(NOW - days * DAY - 1_420_070_400_000) << 22n;
}

Deno.test("the creation time comes from the ID", () => {
  // Discord's documented example: 175928847299117063 is 2016-04-30T11:18:25.796Z.
  assertEquals(accountCreatedAt(175928847299117063n), Date.parse("2016-04-30T11:18:25.796Z"));
});

Deno.test("0 means every account counts, however old", () => {
  assertEquals(countsForRaid(idAged(3000), 0, NOW), true);
});

Deno.test("an account younger than the limit counts", () => {
  assertEquals(countsForRaid(idAged(6), 7, NOW), true);
});

Deno.test("an account older than the limit doesn't", () => {
  assertEquals(countsForRaid(idAged(8), 7, NOW), false);
});

Deno.test("an account exactly at the limit is no longer new", () => {
  assertEquals(countsForRaid(idAged(7), 7, NOW), false);
});
