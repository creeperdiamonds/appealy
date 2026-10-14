// shared/schema/__tests__/answers.test.ts
//
// The browser and the bot both run answerProblem on a web appeal, and the bot's
// answer is the one that counts. These pin the rules both of them apply.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { answerProblem, type AnswerRules } from "../answers.ts";

const rules = (over: Partial<AnswerRules> = {}): AnswerRules => ({
  required: true,
  minLength: null,
  maxLength: null,
  validationType: "none",
  validationPattern: null,
  validationErrorMessage: null,
  ...over,
});

Deno.test("a required question needs more than whitespace", () => {
  assert(answerProblem(rules(), "   "));
  assertEquals(answerProblem(rules(), "yes"), null);
});

Deno.test("an optional question may be left empty, but not filled wrongly", () => {
  assertEquals(answerProblem(rules({ required: false, minLength: 10 }), ""), null);
  assert(answerProblem(rules({ required: false, minLength: 10 }), "short"));
});

Deno.test("length limits", () => {
  assert(answerProblem(rules({ maxLength: 3 }), "1234")?.includes("3 characters"));
  assertEquals(answerProblem(rules({ maxLength: 3 }), "123"), null);
  assert(answerProblem(rules({ minLength: 5 }), "1234"));
});

Deno.test("a pattern uses the form's own message when it has one", () => {
  const q = rules({ validationType: "regex", validationPattern: "^\\d+$", validationErrorMessage: "Numbers only." });
  assertEquals(answerProblem(q, "abc"), "Numbers only.");
  assertEquals(answerProblem(q, "42"), null);
  assert(answerProblem({ ...q, validationErrorMessage: null }, "abc"));
});
