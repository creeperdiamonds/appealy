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
 * pre-checks have to stay cache-backed instead. See MODAL_DELEGATES below
 * for how that indirection is verified.
 */
const MUST_NOT_DEFER = [
  "bot/src/interactions/buttons/panelOpen.ts",
  "bot/src/interactions/buttons/reviewDeny.ts",
  "bot/src/interactions/buttons/verify.ts",
  "bot/src/interactions/selects/formSelectStep.ts",
];

/**
 * Handlers that reach a modal INDIRECTLY, by delegating to a function
 * defined in another file that sends the type: 9 response.
 *
 * An earlier version of this override checked `src.includes(fn)` (true for
 * an import line, a comment, or an unrelated variable of the same name)
 * and `MUST_NOT_DEFER.includes(definedIn)` (true for ANY already-listed
 * path, including the entry's own — the loop iterates MUST_NOT_DEFER
 * itself, so a self-referential definedIn passed trivially). Together
 * those two checks proved nothing: an entry like
 * `{ fn: "import", definedIn: "<any other listed file>" }` satisfied both.
 *
 * The test below closes that instead of asserting around it: it requires
 * the delegating file to actually CALL fn(...) (not merely mention it),
 * reads definedIn's own source off disk, requires that file to DECLARE
 * fn, and requires that file's source to contain the literal modal
 * response (`type: 9`) itself. Only when all four hold does delegation
 * count as proof a modal is reachable.
 */
const MODAL_DELEGATES: Record<string, { fn: string; definedIn: string }> = {
  "bot/src/interactions/selects/formSelectStep.ts": {
    fn: "showApplicationModal",
    definedIn: "bot/src/interactions/buttons/panelOpen.ts",
  },
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
    const delegate = MODAL_DELEGATES[path];
    if (delegate) {
      // A file cannot vouch for itself. The loop iterates MUST_NOT_DEFER, so
      // a self-referential definedIn would otherwise satisfy any membership
      // test trivially.
      assert(
        delegate.definedIn !== path,
        `${path} cannot delegate to itself`,
      );
      // The caller must CALL it, not merely mention it. A bare substring
      // match is satisfied by an import line, a comment, or a variable that
      // happens to share the name.
      assert(
        new RegExp(`\\b${delegate.fn}\\s*\\(`).test(src),
        `${path} must call ${delegate.fn}(...) to reach a modal`,
      );
      const target = await Deno.readTextFile(delegate.definedIn);
      // The target must DECLARE the function. This is the assertion that
      // makes the override honest: an entry naming a common substring like
      // "import" has no matching declaration anywhere and fails here.
      assert(
        new RegExp(`function\\s+${delegate.fn}\\b`).test(target),
        `${delegate.definedIn} must declare function ${delegate.fn}`,
      );
      // And the target must itself open a modal. This is the fact the
      // override borrows; without checking it, delegation proves nothing
      // about whether a modal is reachable at all.
      assert(
        target.includes("type: 9"),
        `${delegate.definedIn} must itself open a modal (type: 9)`,
      );
    } else {
      assert(src.includes("type: 9"), `${path} was expected to open a modal`);
    }
    assert(
      !src.includes("defer("),
      `${path} opens a modal; a deferred interaction cannot show one`,
    );
  });
}
