// bot/src/interactions/__tests__/deferGuard.test.ts
//
// A source-level invariant, not a behavioural test. The interaction flows
// cannot be exercised without Discord, but the property that actually broke
// production is textual and checkable: handlers that do work before
// responding must defer first.
//
// Run from the repository root.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Handlers that await something before they can answer. Every one of these
 * must defer, and must route its responses through the helpers so the
 * ephemeral flag lands on the deferral rather than the edit.
 */
const MUST_DEFER = [
  "bot/src/interactions/buttons/reviewAccept.ts",
  "bot/src/interactions/buttons/ticketOpen.ts",
  "bot/src/interactions/buttons/ticketClose.ts",
  "bot/src/interactions/buttons/giveawayEnter.ts",
  "bot/src/interactions/modals/formSubmit.ts",
  "bot/src/interactions/modals/denyReason.ts",
  "bot/src/interactions/modals/verifyCaptcha.ts",
  "bot/src/interactions/selects/roleMenuSelect.ts",
  "bot/src/interactions/selects/pollVote.ts",
];

/**
 * Handlers whose first response IS a modal. Deferring here is not a style
 * choice — Discord rejects a modal that follows a deferral, so these must
 * never call defer(), and their pre-checks must stay off the network.
 *
 * Membership is proven by the literal `type: 9` appearing in the file: each
 * of these sends its own modal response inline. A handler that reaches a
 * modal indirectly cannot satisfy that, and does not belong in this list —
 * see the dedicated formSelectStep test at the bottom of this file.
 */
const MUST_NOT_DEFER = [
  "bot/src/interactions/buttons/panelOpen.ts",
  "bot/src/interactions/buttons/reviewDeny.ts",
  "bot/src/interactions/buttons/verify.ts",
];

for (const path of MUST_DEFER) {
  Deno.test(`${path} defers before working`, async () => {
    const src = await Deno.readTextFile(path);
    assert(src.includes("defer("), `${path} must call defer() before doing work`);
    assert(
      !src.includes("sendInteractionResponse"),
      `${path} must respond through finish(), not sendInteractionResponse directly`,
    );
    // Presence is not enough. A handler that calls defer() as its LAST
    // statement — after every slow await that caused the bug — satisfies a
    // substring check while still blowing the three-second window, and a
    // green guard over a live bug is worse than no guard at all.
    //
    // Verified safe against ordering: in all nine files listed above the
    // exported handler is defined before the file's first await, so no
    // helper function's await can shadow the handler's deferral.
    const firstAwait = src.indexOf("await ");
    const deferAwait = src.indexOf("await defer(");
    assert(
      deferAwait !== -1 && deferAwait === firstAwait,
      `${path} must defer BEFORE its first await, not after it`,
    );
  });
}

for (const path of MUST_NOT_DEFER) {
  Deno.test(`${path} opens a modal and must not defer`, async () => {
    const src = await Deno.readTextFile(path);
    assert(src.includes("type: 9"), `${path} was expected to open a modal`);
    assert(
      !src.includes("defer("),
      `${path} opens a modal; a deferred interaction cannot show one`,
    );
  });
}

/**
 * formSelectStep.ts is the one handler that reaches a modal indirectly: its
 * "all select questions answered" path calls showApplicationModal(), defined
 * in panelOpen.ts, which sends the type: 9 response. It passes its own
 * interaction straight in, so on that path this handler's response to
 * Discord literally IS a modal. It must therefore never defer — but it never
 * writes "type: 9" itself, so the generic MUST_NOT_DEFER assertion above
 * cannot cover it.
 *
 * This is hardcoded rather than expressed as a reusable override, and that
 * is deliberate. Three attempts at a generic {fn, definedIn} map were each
 * defeated — by `fn: "import"` (a substring of every TypeScript file), by
 * `fn: "respond"` (every file in this tree declares its own private
 * respond() helper, and the call-site regex matched the declaration line
 * rather than a call), and finally by `fn: "grantVerifiedRole"`, a REAL
 * import in a real MUST_DEFER file that passed five of the six checks
 * against genuine unmodified code and was blocked only because verify.ts
 * happens to write `export { grantVerifiedRole }` rather than
 * `export async function` — a routine style cleanup elsewhere would have
 * silently reopened it.
 *
 * Every version failed the same way: the checks were independently
 * satisfiable and never causally tied the named function to the modal
 * response. That is not a bug in any round's implementation; it is inherent
 * to the design. A {fn, definedIn} map is a pair of values a future entry
 * chooses, so any check written against them can be satisfied by
 * coincidence.
 *
 * A generic mechanism takes values a future entry chooses. This takes none,
 * so there is nothing to misuse. If a second indirect case ever appears,
 * add a second block like this one — two hardcoded blocks are better than
 * one mechanism.
 */
Deno.test("formSelectStep reaches a modal via showApplicationModal and must not defer", async () => {
  const src = await Deno.readTextFile("bot/src/interactions/selects/formSelectStep.ts");
  assert(
    src.includes("showApplicationModal("),
    "formSelectStep must call showApplicationModal to reach a modal",
  );
  assert(
    !src.includes("defer("),
    "formSelectStep reaches a modal; a deferred interaction cannot show one",
  );

  // The fact this test borrows: without it, "calls showApplicationModal" would
  // prove nothing about whether a modal is reachable at all.
  const panelOpen = await Deno.readTextFile("bot/src/interactions/buttons/panelOpen.ts");
  assert(
    panelOpen.includes("export async function showApplicationModal("),
    "showApplicationModal must still be exported from panelOpen.ts",
  );
  assert(
    panelOpen.includes("type: 9"),
    "showApplicationModal's home file must still be the thing that opens the modal",
  );
});
