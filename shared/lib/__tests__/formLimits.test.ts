// shared/lib/__tests__/formLimits.test.ts
//
// Run with: deno test shared/lib/__tests__/formLimits.test.ts
//
// Two limits that must not be conflated: a billed cap that a tier raises, and
// Discord's modal ceiling that no tier can. The second exists because
// panelOpen.ts used to silently drop text questions past the fifth, and
// selling a "100 questions" tier on top of that silence would have turned a
// bug into a paid promise.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  countTextQuestions,
  describeQuestionViolation,
  findQuestionLimitViolations,
  IN_SERVER_TEXT_QUESTION_CEILING,
} from "../formLimits.ts";

const text = (n: number) => Array.from({ length: n }, () => ({ type: "short" }));
const select = (n: number) => Array.from({ length: n }, () => ({ type: "select" }));

function violations(opts: Parameters<typeof findQuestionLimitViolations>[0]) {
  return findQuestionLimitViolations(opts).map((v) => v.kind);
}

Deno.test("a form within both limits is fine", () => {
  assertEquals(
    violations({ questions: text(10), tierLimit: 15, applicationType: "in_server" }),
    [],
  );
});

Deno.test("over the tier cap is reported", () => {
  assertEquals(
    violations({ questions: text(16), tierLimit: 15, applicationType: "in_server" }),
    ["tier_cap"],
  );
});

// The whole reason the two are separate. A tier2 guild has bought 100
// questions, and an in-server form still cannot ask more than 25.
Deno.test("buying a higher tier does not lift Discord's modal ceiling", () => {
  assertEquals(
    violations({ questions: text(30), tierLimit: 100, applicationType: "in_server" }),
    ["modal_ceiling"],
  );
});

Deno.test("a DM form is not subject to the modal ceiling", () => {
  // Asked one at a time by dmApplicationService; no modal is ever built.
  assertEquals(
    violations({ questions: text(90), tierLimit: 100, applicationType: "direct_message" }),
    [],
  );
});

Deno.test("both limits can be violated at once, and both are reported", () => {
  assertEquals(
    violations({ questions: text(40), tierLimit: 15, applicationType: "in_server" }),
    ["tier_cap", "modal_ceiling"],
  );
});

// Select questions are answered before the modal opens, so they do not consume
// modal components and must not count toward the ceiling.
Deno.test("select questions do not count toward the modal ceiling", () => {
  assertEquals(countTextQuestions([...text(5), ...select(40)]), 5);
  assertEquals(
    violations({
      questions: [...text(20), ...select(30)],
      tierLimit: 100,
      applicationType: "in_server",
    }),
    [],
  );
});

// Grandfathering, matching findRoleCapViolations: both caps arrived after
// forms existed, and refusing to save a form somebody has run for months
// because of a limit introduced underneath them punishes the wrong person.
Deno.test("an existing over-cap form may be saved unchanged", () => {
  assertEquals(
    violations({
      questions: text(40),
      tierLimit: 15,
      applicationType: "direct_message",
      previousCount: 40,
    }),
    [],
  );
});

Deno.test("an existing over-cap form may shrink", () => {
  assertEquals(
    violations({
      questions: text(30),
      tierLimit: 15,
      applicationType: "direct_message",
      previousCount: 40,
    }),
    [],
  );
});

Deno.test("an existing over-cap form may not grow", () => {
  assertEquals(
    violations({
      questions: text(41),
      tierLimit: 15,
      applicationType: "direct_message",
      previousCount: 40,
    }),
    ["tier_cap"],
  );
});

Deno.test("the modal ceiling grandfathers the same way", () => {
  assertEquals(
    violations({
      questions: text(30),
      tierLimit: 100,
      applicationType: "in_server",
      previousTextCount: 30,
    }),
    [],
  );
  assertEquals(
    violations({
      questions: text(31),
      tierLimit: 100,
      applicationType: "in_server",
      previousTextCount: 30,
    }),
    ["modal_ceiling"],
  );
});

Deno.test("the ceiling is the paging arithmetic, not a second constant", () => {
  assertEquals(IN_SERVER_TEXT_QUESTION_CEILING, 25);
});

Deno.test("exactly at each limit is allowed", () => {
  assertEquals(
    violations({ questions: text(15), tierLimit: 15, applicationType: "in_server" }),
    [],
  );
  assertEquals(
    violations({
      questions: text(IN_SERVER_TEXT_QUESTION_CEILING),
      tierLimit: 100,
      applicationType: "in_server",
    }),
    [],
  );
});

// The message has to tell an admin what to DO. "Switch to DM delivery" is the
// actual escape from the modal ceiling, and no amount of paying is.
Deno.test("the modal-ceiling message offers the real remedy", () => {
  const msg = describeQuestionViolation({ kind: "modal_ceiling", textCount: 30, limit: 25 });
  assertEquals(msg.includes("DM delivery"), true);
  assertEquals(msg.toLowerCase().includes("no tier raises this"), true);
});

Deno.test("the tier-cap message names both numbers", () => {
  const msg = describeQuestionViolation({ kind: "tier_cap", count: 30, limit: 15 });
  assertEquals(msg.includes("30"), true);
  assertEquals(msg.includes("15"), true);
});
