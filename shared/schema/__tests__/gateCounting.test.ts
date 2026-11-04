// shared/schema/__tests__/gateCounting.test.ts
//
// "Reset cooldowns for everyone" works by moving where the cooldown and the
// submission limits start counting. Both gate paths (the panel button and the
// DM / web appeal flow) read gateCountingFrom, so a boundary mistake here
// either blocks everyone after a reset or quietly undoes a form's limits.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gateCountingFrom } from "../gating.ts";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-11-05T12:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

Deno.test("never reset, no window: counts everything", () => {
  assertEquals(gateCountingFrom(null), null);
  assertEquals(gateCountingFrom(null, null), null);
});

Deno.test("never reset: a rolling window starts where it always did", () => {
  assertEquals(gateCountingFrom(null, ago(24)), ago(24));
});

Deno.test("reset, no window: counts only what came after the reset", () => {
  assertEquals(gateCountingFrom(ago(2)), ago(2));
});

Deno.test("reset inside the window: the reset wins, older submissions stop counting", () => {
  assertEquals(gateCountingFrom(ago(2), ago(24)), ago(2));
});

Deno.test("reset before the window: the window wins, the old reset changes nothing", () => {
  assertEquals(gateCountingFrom(ago(48), ago(24)), ago(24));
});
