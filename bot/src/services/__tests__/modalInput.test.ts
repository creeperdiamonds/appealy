// bot/src/services/__tests__/modalInput.test.ts
//
// Run with: deno test -c bot/deno.json bot/src/services/__tests__/modalInput.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MODAL_LIMITS, modalTextLimits } from "../modalInput.ts";

Deno.test("an ordinary question passes through unchanged", () => {
  assertEquals(modalTextLimits({ label: "Why do you want to join?", placeholder: "A few sentences", minLength: 20, maxLength: 1000 }), {
    label: "Why do you want to join?",
    placeholder: "A few sentences",
    minLength: 20,
    maxLength: 1000,
  });
});

Deno.test("no maximum means Discord's own ceiling", () => {
  assertEquals(modalTextLimits({ label: "Age" }).maxLength, MODAL_LIMITS.value);
});

Deno.test("a minimum above the maximum is lowered to it", () => {
  const r = modalTextLimits({ label: "Q", minLength: 500, maxLength: 100 });
  assertEquals(r.minLength, 100);
  assertEquals(r.maxLength, 100);
});

Deno.test("a minimum alone above 4000 is brought down to the ceiling", () => {
  assertEquals(modalTextLimits({ label: "Q", minLength: 9000 }).minLength, MODAL_LIMITS.value);
});

Deno.test("a maximum of 0 or a negative one becomes 1", () => {
  assertEquals(modalTextLimits({ label: "Q", maxLength: 0 }).maxLength, 1);
  assertEquals(modalTextLimits({ label: "Q", maxLength: -5 }).maxLength, 1);
});

Deno.test("a minimum of 0 is left out rather than sent", () => {
  assertEquals(modalTextLimits({ label: "Q", minLength: 0 }).minLength, undefined);
});

Deno.test("long labels and placeholders are shortened with an ellipsis", () => {
  const r = modalTextLimits({ label: "x".repeat(200), placeholder: "y".repeat(300) });
  assertEquals(r.label.length, MODAL_LIMITS.label);
  assert(r.label.endsWith("…"));
  assertEquals(r.placeholder!.length, MODAL_LIMITS.placeholder);
});

Deno.test("an empty label gets a stand-in, and a blank placeholder is dropped", () => {
  const r = modalTextLimits({ label: "   ", placeholder: "  " });
  assertEquals(r.label, "Question");
  assertEquals(r.placeholder, undefined);
});
