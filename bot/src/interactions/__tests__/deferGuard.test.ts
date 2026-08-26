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
  // Slash commands added in Task 7. exportApplications.ts, resetCooldown.ts,
  // and importAppy.ts are deliberately NOT here even though their `execute`
  // handlers were converted the same way — see the dedicated tests below
  // for why. apply.ts is also deliberately not here — see the dedicated
  // test for it below, right next to formSelectStep's.
  "bot/src/commands/exportData.ts",
  "bot/src/commands/panelCreate.ts",
  "bot/src/commands/pollCreate.ts",
  "bot/src/commands/giveaway.ts",
  "bot/src/commands/roleMenu.ts",
  "bot/src/commands/ticketPanel.ts",
  "bot/src/commands/verifySetup.ts",
  "bot/src/commands/antiRaid.ts",
  "bot/src/commands/formList.ts",
  "bot/src/commands/botStats.ts",
  // Fix round 1: two candidates the original Task 7 pass missed entirely
  // (both did REST work via isGuildOwner() before responding, unguarded).
  "bot/src/commands/importAppealy.ts",
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
 *
 * Nor does a handler where only SOME branches open a modal: verify.ts used to
 * be listed here and no longer is, because its captcha branch opens a modal
 * while its button branch defers. Both assertions below would be wrong for
 * it. See its dedicated block at the bottom of this file.
 */
const MUST_NOT_DEFER = [
  "bot/src/interactions/buttons/panelOpen.ts",
  "bot/src/interactions/buttons/reviewDeny.ts",
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
    // Verified safe against ordering: in every file listed above, the
    // exported handler that must defer is defined before the file's first
    // await, so no helper function's await can shadow the handler's
    // deferral. (Three slash commands — exportApplications.ts,
    // resetCooldown.ts, and importAppy.ts — also pair `execute` with an
    // `autocomplete` export that legitimately keeps its own direct
    // response; they're deliberately NOT in this array because the "no
    // sendInteractionResponse" assertion just above can't distinguish that
    // legitimate call from a regression. See their dedicated test below.)
    //
    // BE HONEST ABOUT WHAT THIS PROVES. It proves TEXTUAL order, not
    // execution order; the two coincide here only because of a convention —
    // helpers declared after the handler they serve — that nothing in this
    // repository enforces. And it is per-FILE, not per-handler:
    // src.indexOf("await ") finds the first await anywhere in the file, so in
    // a multi-handler file it constrains only the textually first handler.
    // ticketClose.ts exports three; the other two could each be given a REST
    // call ahead of their defer() and this assertion would stay green. That
    // is a false negative — the dangerous direction — and it is left
    // unfixed deliberately: a real parse is disproportionate for 21 files.
    // What is not acceptable is a comment claiming more than the code checks,
    // which is the same defect this branch fixed in statusPublisher's.
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
 * exportApplications.ts, resetCooldown.ts, and importAppy.ts (Task 7, the
 * last added in fix round 1) each pair a normal slash-command `execute`
 * handler with an `autocomplete` export for one of their string options.
 * Autocomplete is a genuinely different interaction type
 * (APPLICATION_COMMAND_AUTOCOMPLETE) that Discord only accepts an
 * immediate `type: 8` response for — there is no deferred variant, so
 * `autocomplete()` must keep calling the raw interaction-response helper
 * directly even after `execute()` is converted to defer/finish. That
 * legitimate, unavoidable second response call defeats the generic
 * MUST_DEFER loop's "no sendInteractionResponse anywhere in the file"
 * assertion, which has no way to tell a permitted autocomplete response
 * apart from a regression that smuggled a direct response back into
 * `execute()`. Hardcoded here rather than added to a new exemption list,
 * for the same reason formSelectStep's case below is hardcoded: an
 * exemption list takes a value (a path) a future entry chooses, so a check
 * against it can be satisfied by an unrelated file coincidentally matching
 * the same shape. This test instead pins down exactly the two things that
 * make the exception legitimate: the file has precisely one
 * sendInteractionResponse call left, and it lives inside autocomplete(),
 * answering with type: 8.
 */
for (
  const path of [
    "bot/src/commands/exportApplications.ts",
    "bot/src/commands/resetCooldown.ts",
    "bot/src/commands/importAppy.ts",
  ]
) {
  Deno.test(`${path} defers execute() before working; autocomplete() is exempt`, async () => {
    const src = await Deno.readTextFile(path);
    assert(src.includes("await defer("), `${path} must call defer() before doing work in execute()`);

    const firstAwait = src.indexOf("await ");
    const deferAwait = src.indexOf("await defer(");
    assert(
      deferAwait !== -1 && deferAwait === firstAwait,
      `${path} must defer BEFORE its first await, not after it`,
    );

    // Exactly one raw interaction-response call may remain in the file —
    // more than one means a regression reintroduced a direct response
    // somewhere other than autocomplete(); zero means autocomplete() was
    // rewritten in a way that no longer works (there is no defer()-based
    // path for it).
    const occurrences = src.split("sendInteractionResponse").length - 1;
    assert(
      occurrences === 1,
      `${path} should have exactly one sendInteractionResponse call (autocomplete's), found ${occurrences}`,
    );

    const autocompleteIndex = src.indexOf("async function autocomplete(");
    const callIndex = src.indexOf("sendInteractionResponse");
    assert(
      autocompleteIndex !== -1 && callIndex > autocompleteIndex,
      `${path}'s remaining sendInteractionResponse call must be inside autocomplete()`,
    );
    assert(
      src.slice(callIndex, callIndex + 200).includes("type: 8"),
      `${path}'s remaining sendInteractionResponse call must be autocomplete's type: 8 result, not a message response`,
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

/**
 * apply.ts (Task 7) is the second indirect-modal case anticipated in the
 * comment above: the /apply slash command hands off to
 * runApplicationFlow(), the same function panelOpen.ts's button handler
 * calls, and that function's happy path ends in proceedToQuestions() ->
 * showApplicationModal() — a type: 9 response. apply.ts's own source never
 * writes "type: 9" (it doesn't even import showApplicationModal directly),
 * so it can satisfy neither the generic MUST_NOT_DEFER assertion nor a
 * naive "calls a function named X" check without also proving that
 * function chain still terminates in a modal. Hardcoded per file, the same
 * as formSelectStep's block above, rather than generalized into a second
 * exemption list for the reasons documented there.
 */
Deno.test("apply.ts reaches a modal via runApplicationFlow and must not defer", async () => {
  const src = await Deno.readTextFile("bot/src/commands/apply.ts");
  assert(
    src.includes("runApplicationFlow("),
    "apply.ts must call runApplicationFlow to reach gating and, ultimately, the modal",
  );
  assert(
    !src.includes("defer("),
    "apply.ts's happy path can end in a modal; a deferred interaction cannot show one",
  );

  // The chain this test relies on: runApplicationFlow -> proceedToQuestions
  // -> showApplicationModal -> type: 9. The assertions below check that each
  // link is still present in panelOpen.ts — they are file-scoped, not
  // call-scoped, so they do not prove the calls remain wired to one another.
  // Even so, without them "apply.ts calls runApplicationFlow" would prove
  // nothing at all about a modal being reachable.
  const panelOpen = await Deno.readTextFile("bot/src/interactions/buttons/panelOpen.ts");
  assert(
    panelOpen.includes("export async function runApplicationFlow("),
    "runApplicationFlow must still be exported from panelOpen.ts",
  );
  assert(
    panelOpen.includes("await proceedToQuestions("),
    "runApplicationFlow's happy path must still reach proceedToQuestions",
  );
  assert(
    panelOpen.includes("await showApplicationModal("),
    "proceedToQuestions' no-select-questions path must still reach showApplicationModal",
  );
  assert(
    panelOpen.includes("type: 9"),
    "showApplicationModal's home file must still be the thing that opens the modal",
  );
});

/**
 * verify.ts is the third hardcoded case, and the only SPLIT one: a single
 * file where one branch must open a modal and the other must defer.
 *
 * Its captcha branch sends a `type: 9` modal inline, so it belongs to the
 * MUST_NOT_DEFER family. Its button branch — the default, since
 * commands/verifySetup.ts falls back to "button" when no method is given —
 * does four sequential Discord REST calls (getGuild and getMember inside
 * findUnmanageableRoles, then addRole and removeRole) plus two database round
 * trips before it can answer, which is the reviewAccept latency profile on
 * the new-member onboarding path. So it belongs to the MUST_DEFER family too,
 * and neither generic loop above can express that: MUST_NOT_DEFER asserts the
 * file never writes `defer(`, MUST_DEFER asserts it never writes
 * `sendInteractionResponse`, and this file legitimately does both.
 *
 * It could not be a MUST_DEFER entry for a second, independent reason. That
 * loop asserts the file's FIRST `await ` is `await defer(`, and here the
 * first await is the verificationConfigs lookup — which has to stay ahead of
 * both branches, because whether deferring is even legal depends on which
 * method the guild configured. The ordering assertion is exactly right for
 * the twenty files it covers and exactly wrong for this one.
 *
 * Hardcoded per file, like the two blocks above and for the reasons set out
 * in formSelectStep's: a generic mechanism takes values a future entry
 * chooses, so any check written against them can be satisfied by an unrelated
 * file coincidentally matching the same shape. Three hardcoded blocks are
 * better than one mechanism.
 */
Deno.test("verify.ts defers its button branch and still opens the captcha modal", async () => {
  const src = await Deno.readTextFile("bot/src/interactions/buttons/verify.ts");
  assert(
    src.includes("type: 9"),
    "verify.ts's captcha branch must still open a modal inline",
  );
  assert(
    src.includes("await defer("),
    "verify.ts's button branch must defer before its REST and database work",
  );
});
