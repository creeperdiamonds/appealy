// shared/services/__tests__/dataImport.test.ts
//
// Run with: deno test shared/services/__tests__/dataImport.test.ts
//
// dataImport.ts is almost entirely database work and cannot be tested without
// one. These cover the part that decides POLICY rather than does IO: how a
// role list that exceeds the receiving guild's cap is handled, and which
// rules make that dangerous rather than merely lossy.
//
// The distinction is the point. Trimming requiredRoleIds admits MORE people
// than the source server did — the same open door the file already guards
// against when a gate's roles fail to map. Trimming grantRoleIds hands out
// fewer roles: wrong, but not a way in.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clampRoleIds, trimmingWidensAccess } from "../dataImport.ts";
import { FORM_GATING_ROLE_RULES, FORM_ROLE_RULES } from "../../schema/pricing.ts";

Deno.test("a list within the cap is returned untouched", () => {
  const { kept, dropped } = clampRoleIds(["a", "b", "c"], 3);
  assertEquals(kept, ["a", "b", "c"]);
  assertEquals(dropped, []);
});

Deno.test("an over-cap list keeps the first N and reports the rest", () => {
  const { kept, dropped } = clampRoleIds(["a", "b", "c", "d", "e"], 3);
  assertEquals(kept, ["a", "b", "c"]);
  assertEquals(dropped, ["d", "e"]);
});

Deno.test("an empty list is not an error", () => {
  const { kept, dropped } = clampRoleIds([], 3);
  assertEquals(kept, []);
  assertEquals(dropped, []);
});

// The realistic trigger is not abuse: it is a tier2 server (25 per rule)
// exporting into a free one (3).
Deno.test("a tier2 role list clamps to the free cap", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `role-${i}`);
  const { kept, dropped } = clampRoleIds(ids, 3);
  assertEquals(kept.length, 3);
  assertEquals(dropped.length, 22);
});

Deno.test("trimming a gate widens access; trimming an effect does not", () => {
  assertEquals(trimmingWidensAccess("requiredRoleIds"), true);
  assertEquals(trimmingWidensAccess("blacklistedRoleIds"), true);

  assertEquals(trimmingWidensAccess("grantRoleIds"), false);
  assertEquals(trimmingWidensAccess("removeRoleIds"), false);
  assertEquals(trimmingWidensAccess("pingRoleIds"), false);
  // Narrows who may review rather than widening who may apply, so it does not
  // deactivate the form — and the cap is never low enough to empty it, which
  // is what would fail the whitelist open.
  assertEquals(trimmingWidensAccess("reviewerRoleIds"), false);
});

// Guards the reason trimmingWidensAccess derives from the constant instead of
// restating it: a gating rule added to pricing.ts must not leave dataImport
// importing that form active.
Deno.test("every gating rule is a real form role rule", () => {
  for (const rule of FORM_GATING_ROLE_RULES) {
    assertEquals(
      (FORM_ROLE_RULES as readonly string[]).includes(rule),
      true,
      `${rule} is listed as a gating rule but is not a form role rule`,
    );
  }
});

Deno.test("an unknown rule is treated as non-gating", () => {
  assertEquals(trimmingWidensAccess("somethingElseEntirely"), false);
});
