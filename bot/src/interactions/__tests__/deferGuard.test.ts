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
  "bot/src/interactions/selects/formSelectStep.ts",
];

/**
 * Handlers whose first response IS a modal. Deferring here is not a style
 * choice — Discord rejects a modal that follows a deferral, so these must
 * never call defer(), and their pre-checks must stay off the network.
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
