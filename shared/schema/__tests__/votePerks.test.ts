// shared/schema/__tests__/votePerks.test.ts
//
// Run with: deno test shared/schema/__tests__/votePerks.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { RATE_LIMIT_PRESETS } from "../pricing.ts";
import { VOTE_PERKS, parseActivePerk, voteBonus, withVoteBonus } from "../votePerks.ts";

const free = RATE_LIMIT_PRESETS.free.caps;
const tier1 = RATE_LIMIT_PRESETS.tier1.caps;

Deno.test("no perk lifts a free server anywhere near Tier 1", () => {
  // The whole point of keeping them small: farming votes must not replace
  // buying a tier. A perk may add at most a third of the free allowance.
  for (const p of VOTE_PERKS) {
    const boosted = free[p.cap] + p.bonus;
    assertEquals(p.bonus <= free[p.cap] / 3, true, `${p.id} is too generous`);
    assertEquals(boosted < tier1[p.cap] / 2, true, `${p.id} gets too close to Tier 1`);
  }
});

Deno.test("perk ids are unique", () => {
  assertEquals(new Set(VOTE_PERKS.map((p) => p.id)).size, VOTE_PERKS.length);
});

Deno.test("an active perk raises only its own cap", () => {
  const active = { perk: "tickets", userId: "1", until: Date.now() + 1000 };
  const caps = withVoteBonus(free, active);
  assertEquals(caps.ticketsPerDay, free.ticketsPerDay + 25);
  assertEquals(caps.submissionsPerDay, free.submissionsPerDay);
  assertEquals(voteBonus(active, "ticketsPerDay"), 25);
  assertEquals(voteBonus(active, "submissionsPerDay"), 0);
});

Deno.test("nothing active leaves the caps untouched", () => {
  assertEquals(withVoteBonus(free, null), free);
  assertEquals(voteBonus(null, "ticketsPerDay"), 0);
});

Deno.test("expired, unknown and malformed perks read as none", () => {
  const now = 1_000_000;
  assertEquals(parseActivePerk(null, now), null);
  assertEquals(parseActivePerk("not json", now), null);
  assertEquals(parseActivePerk(JSON.stringify({ perk: "forms", userId: "1", until: now + 5 }), now), null);
  assertEquals(parseActivePerk(JSON.stringify({ perk: "tickets", userId: "1", until: now }), now), null);
  assertEquals(
    parseActivePerk(JSON.stringify({ perk: "tickets", userId: "1", until: now + 5 }), now),
    { perk: "tickets", userId: "1", until: now + 5 },
  );
});
