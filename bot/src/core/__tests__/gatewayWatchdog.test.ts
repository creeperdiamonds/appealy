import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createGatewayWatchdog } from "../gatewayWatchdog.ts";

const MIN = 60_000;

Deno.test("a single blip, even with many quick retries, does not trip it", () => {
  const w = createGatewayWatchdog();
  // 13 Nov 21:55: about a dozen failed connects inside two seconds, then fine.
  for (let i = 0; i < 12; i++) assertEquals(w.recordDisconnect(i * 200), false);
});

Deno.test("Discord's normal occasional reconnects do not trip it", () => {
  const w = createGatewayWatchdog();
  // One every 20 minutes for a day.
  for (let t = 0; t < 24 * 60 * MIN; t += 20 * MIN) assertEquals(w.recordDisconnect(t), false);
});

Deno.test("the stuck loop (a close every ~25 seconds) trips it within 5 minutes", () => {
  const w = createGatewayWatchdog();
  let trippedAt = -1;
  for (let t = 0; t < 30 * MIN; t += 25_000) {
    if (w.recordDisconnect(t)) {
      trippedAt = t;
      break;
    }
  }
  assertEquals(trippedAt > 0 && trippedAt <= 5 * MIN, true);
});

Deno.test("disconnects spread over more than the window do not add up", () => {
  const w = createGatewayWatchdog();
  // One every 3 minutes: never 5 different minutes inside any 10.
  for (let t = 0; t < 120 * MIN; t += 3 * MIN) assertEquals(w.recordDisconnect(t), false);
});

Deno.test("two blips a few minutes apart do not trip it", () => {
  const w = createGatewayWatchdog();
  for (let i = 0; i < 10; i++) w.recordDisconnect(i * 100);
  for (let i = 0; i < 10; i++) assertEquals(w.recordDisconnect(4 * MIN + i * 100), false);
});
