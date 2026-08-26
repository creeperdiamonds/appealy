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
 * Two earlier designs here both turned out to be four independent
 * whole-file checks that were satisfiable by coincidence rather than by
 * actually tying the caller to the target:
 *
 *   - v1 checked `src.includes(fn)` and `MUST_NOT_DEFER.includes(definedIn)`
 *     — defeated by `{ fn: "import", definedIn: <any other listed file> }`,
 *     since "import" is a near-universal substring and list membership is
 *     true for any already-listed path, including the entry's own.
 *   - v2 added a call-site regex (`\bfn\s*\(`) and read the target off disk
 *     to require a `function fn` declaration plus a literal `type: 9` —
 *     defeated by `{ fn: "respond", definedIn: <any MUST_NOT_DEFER file> }`,
 *     because EVERY file in this tree (deferring and non-deferring alike)
 *     declares its own private `async function respond(...)` helper, and
 *     `async function respond(` itself matches `\brespond\s*\(` — so the
 *     "call" check passed on the declaration line, no actual call to the
 *     delegate required, and the declaration + type:9 checks passed on
 *     TOTALLY UNRELATED code in the target file.
 *
 * What was missing both times: nothing tied the CALLER's use of fn to the
 * TARGET's definition of fn. The fix is an import — the caller must
 * literally `import { fn } from definedIn`. A file's own local helper is
 * never imported, so neither demonstrated attack can satisfy this. Also
 * requires the target to EXPORT fn (a private function cannot be the thing
 * an import binds to), and validates fn as a plain identifier before it
 * touches any RegExp, since fn is test data, not literal source — an
 * unvalidated fn containing a regex metacharacter would let a malformed
 * entry throw a SyntaxError instead of failing an assertion.
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
      // fn is test data feeding several RegExp constructors below, not
      // literal source. Validate it as a plain identifier BEFORE any of
      // those run, so a malformed entry (e.g. fn containing "(") fails an
      // assertion instead of throwing a SyntaxError out of `new RegExp`.
      assert(
        /^[A-Za-z_$][\w$]*$/.test(delegate.fn),
        `${path}: delegate fn must be a plain identifier, got ${delegate.fn}`,
      );
      // The caller must CALL it, not merely mention it. A bare substring
      // match is satisfied by an import line, a comment, or a variable that
      // happens to share the name — kept as a cheap early check, but see
      // the import assertion below for the one that actually closes this.
      assert(
        new RegExp(`\\b${delegate.fn}\\s*\\(`).test(src),
        `${path} must call ${delegate.fn}(...) to reach a modal`,
      );
      // The load-bearing check. Four independent whole-file checks were all
      // satisfiable by coincidence: every file in this tree declares its own
      // private respond() helper, and the call-site regex matched the
      // declaration line rather than a call, so a handler could claim a
      // delegate it never touched. An import names the exact binding and the
      // exact module, which is the only thing here that actually ties the
      // caller to the target.
      const modulePath = delegate.definedIn.replace(/^.*\/([^/]+)$/, "$1");
      assert(
        new RegExp(
          `import[\\s\\S]*?\\b${delegate.fn}\\b[\\s\\S]*?from\\s*["'][^"']*${modulePath.replace(".", "\\.")}["']`,
        ).test(src),
        `${path} must import ${delegate.fn} from ${delegate.definedIn}`,
      );
      const target = await Deno.readTextFile(delegate.definedIn);
      // The target must EXPORT the function, not merely declare it — a
      // private function is not a thing the caller's import could have
      // bound to, so an unexported fn means the import assertion above
      // could only have been satisfied by importing something else.
      assert(
        new RegExp(`export\\s+(async\\s+)?function\\s+${delegate.fn}\\b`).test(target),
        `${delegate.definedIn} must export function ${delegate.fn}`,
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
