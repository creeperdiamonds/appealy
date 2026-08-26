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
 * formSelectStep.ts belongs here, not in MUST_DEFER, even though it does a
 * cache write and a DB read before responding. When more select questions
 * remain it answers with an UPDATE_MESSAGE (type: 7), but when they've all
 * been answered its response IS a modal: it delegates to
 * showApplicationModal() in panelOpen.ts, which is the one place the
 * literal `type: 9` lives for this flow. A deferred interaction can never
 * open a modal, so this handler must not defer on either path — its
 * pre-checks have to stay cache-backed instead. See MODAL_MARKER below for
 * how that indirection is verified.
 */
const MUST_NOT_DEFER = [
  "bot/src/interactions/buttons/panelOpen.ts",
  "bot/src/interactions/buttons/reviewDeny.ts",
  "bot/src/interactions/buttons/verify.ts",
  "bot/src/interactions/selects/formSelectStep.ts",
];

/**
 * What to search for to confirm a MUST_NOT_DEFER file actually opens a
 * modal. Most of these files send `type: 9` directly, so that's the
 * default. formSelectStep.ts is the one exception — it never writes
 * `type: 9` itself, it calls into showApplicationModal() (panelOpen.ts) to
 * do it — so it needs its own marker rather than failing the default check.
 */
const MODAL_MARKER: Record<string, string> = {
  "bot/src/interactions/selects/formSelectStep.ts": "showApplicationModal(",
};

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
    // Verified safe against ordering: in all ten files listed above the
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
    const marker = MODAL_MARKER[path] ?? "type: 9";
    assert(src.includes(marker), `${path} was expected to open a modal`);
    assert(
      !src.includes("defer("),
      `${path} opens a modal; a deferred interaction cannot show one`,
    );
  });
}
