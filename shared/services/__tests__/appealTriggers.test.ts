// shared/services/__tests__/appealTriggers.test.ts
//
// Run with: deno test shared/services/__tests__/appealTriggers.test.ts
//
// Guards the two rules that decide whether a punished member is DMed: one
// notice per punishment, and none for punishments too short to appeal.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { diffRestrictionNotices, timeoutNoticeKey } from "../appealTriggers.ts";

const NO_MEDIA = "111", NO_PINGS = "222", MEMBER = "999", BOOSTER = "888";

Deno.test("a newly given restriction role gets a notice", () => {
  assertEquals(diffRestrictionNotices([MEMBER, NO_MEDIA], [NO_MEDIA, NO_PINGS], []), {
    notify: [NO_MEDIA],
    clear: [],
  });
});

Deno.test("a role already noticed is not noticed again on later updates", () => {
  // e.g. the member changed their nickname while still restricted
  assertEquals(diffRestrictionNotices([MEMBER, NO_MEDIA], [NO_MEDIA], [NO_MEDIA]), {
    notify: [],
    clear: [],
  });
});

Deno.test("roles that aren't restrictions are ignored", () => {
  assertEquals(diffRestrictionNotices([MEMBER, BOOSTER], [NO_MEDIA, NO_PINGS], []), {
    notify: [],
    clear: [],
  });
});

Deno.test("a removed restriction's notice is cleared, so it can be sent again later", () => {
  assertEquals(diffRestrictionNotices([MEMBER], [NO_MEDIA], [NO_MEDIA]), {
    notify: [],
    clear: [NO_MEDIA],
  });
});

Deno.test("stepping down a tier notices the new role and forgets the old one", () => {
  assertEquals(diffRestrictionNotices([MEMBER, NO_PINGS], [NO_MEDIA, NO_PINGS], [NO_MEDIA]), {
    notify: [NO_PINGS],
    clear: [NO_MEDIA],
  });
});

Deno.test("a notice for a role no longer configured as a restriction is cleared", () => {
  assertEquals(diffRestrictionNotices([MEMBER, NO_MEDIA], [NO_PINGS], [NO_MEDIA]), {
    notify: [],
    clear: [NO_MEDIA],
  });
});

const NOW = 1_800_000_000_000;
const HOUR = 3600;

Deno.test("no timeout, or one already over, gets no notice", () => {
  assertEquals(timeoutNoticeKey(undefined, NOW, HOUR), null);
  assertEquals(timeoutNoticeKey(null, NOW, HOUR), null);
  assertEquals(timeoutNoticeKey(NOW - 1, NOW, HOUR), null);
  assertEquals(timeoutNoticeKey(NOW, NOW, HOUR), null);
});

Deno.test("a timeout shorter than the threshold gets no notice", () => {
  assertEquals(timeoutNoticeKey(NOW + 10 * 60_000, NOW, HOUR), null);
});

Deno.test("a timeout exactly as long as the threshold gets a notice, though measured late", () => {
  // Discord's "1 hour" preset under the default 1-hour threshold: by the time
  // the event arrives, a little less than an hour is left.
  const until = NOW + HOUR * 1000;
  assertEquals(timeoutNoticeKey(until, NOW + 800, HOUR), String(until));
});

Deno.test("the slack is a minute, not a rounding of the threshold", () => {
  assertEquals(timeoutNoticeKey(NOW + 58 * 60_000, NOW, HOUR), null);
});

Deno.test("a long enough timeout is keyed by its end time", () => {
  const until = NOW + 7 * 24 * HOUR * 1000;
  assertEquals(timeoutNoticeKey(until, NOW, HOUR), String(until));
});

Deno.test("a threshold of zero notices any running timeout", () => {
  assertEquals(timeoutNoticeKey(NOW + 60_000, NOW, 0), String(NOW + 60_000));
});

Deno.test("an extended timeout is a new punishment with a new key", () => {
  const first = timeoutNoticeKey(NOW + 2 * HOUR * 1000, NOW, HOUR);
  const extended = timeoutNoticeKey(NOW + 5 * HOUR * 1000, NOW, HOUR);
  assertEquals(first !== null && extended !== null && first !== extended, true);
});
