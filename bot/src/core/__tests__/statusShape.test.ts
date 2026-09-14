// bot/src/core/__tests__/statusShape.test.ts
//
// The previous publisher read `shard.connected`, a field Discordeno 20 does
// not have, so every shard would have been reported down. These pin the
// fields that do exist.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyShard, SHARD_CONNECTED, SLOW_RTT_MS } from "../statusShape.ts";

Deno.test("a connected shard with a normal round-trip is up", () => {
  assertEquals(classifyShard({ state: SHARD_CONNECTED, heart: { rtt: 80 } }), "up");
  // No round-trip measured yet is not evidence of slowness.
  assertEquals(classifyShard({ state: SHARD_CONNECTED, heart: {} }), "up");
});

Deno.test("a connected shard with a slow round-trip is degraded", () => {
  assertEquals(classifyShard({ state: SHARD_CONNECTED, heart: { rtt: SLOW_RTT_MS + 1 } }), "degraded");
});

Deno.test("any state other than Connected is down", () => {
  for (const state of [1, 2, 3, 4, 5, 6]) {
    assertEquals(classifyShard({ state, heart: { rtt: 50 } }), "down");
  }
  assertEquals(classifyShard({}), "down");
});
