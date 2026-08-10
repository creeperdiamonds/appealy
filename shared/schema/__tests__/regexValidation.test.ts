// shared/schema/__tests__/regexValidation.test.ts
//
// Run with: deno test shared/schema/__tests__/regexValidation.test.ts
//
// Covers: valid patterns, invalid syntax, each rejected ReDoS-shaped
// construct, the length caps, and the select-question exclusion is
// covered separately in api/src/routes/forms.ts's zod refine (not
// re-tested here since it's Express/zod-specific, not part of this
// module's own surface).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkPatternSafety, validateAnswerAgainstPattern } from "../regexValidation.ts";

// --- checkPatternSafety: valid patterns ---------------------------------

Deno.test("checkPatternSafety accepts a simple literal pattern", () => {
  const result = checkPatternSafety("^[A-Za-z0-9_]{3,16}$");
  assertEquals(result.valid, true);
});

Deno.test("checkPatternSafety accepts a simple alternation without quantifier", () => {
  const result = checkPatternSafety("^(yes|no)$");
  assertEquals(result.valid, true);
});

Deno.test("checkPatternSafety accepts a single non-nested quantifier", () => {
  const result = checkPatternSafety("^\\d+$");
  assertEquals(result.valid, true);
});

// --- checkPatternSafety: invalid syntax ---------------------------------

Deno.test("checkPatternSafety rejects unbalanced parentheses", () => {
  const result = checkPatternSafety("^(abc$");
  assertEquals(result.valid, false);
});

Deno.test("checkPatternSafety rejects an empty pattern", () => {
  const result = checkPatternSafety("");
  assertEquals(result.valid, false);
  assertEquals(result.reason, "Pattern cannot be empty.");
});

// --- checkPatternSafety: ReDoS-shaped constructs ------------------------

Deno.test("checkPatternSafety rejects nested quantified groups (a+)+", () => {
  const result = checkPatternSafety("^(a+)+$");
  assertEquals(result.valid, false);
});

Deno.test("checkPatternSafety rejects nested quantified groups (\\d*)*", () => {
  const result = checkPatternSafety("(\\d*)*");
  assertEquals(result.valid, false);
});

Deno.test("checkPatternSafety rejects quantified alternation (a|ab)+", () => {
  const result = checkPatternSafety("(a|ab)+");
  assertEquals(result.valid, false);
});

Deno.test("checkPatternSafety rejects backreferences", () => {
  const result = checkPatternSafety("(a)\\1");
  assertEquals(result.valid, false);
  assertEquals(result.reason, "Backreferences (e.g. \\1) are not allowed.");
});

Deno.test("checkPatternSafety rejects lookaheads", () => {
  const result = checkPatternSafety("foo(?=bar)");
  assertEquals(result.valid, false);
  assertEquals(result.reason, "Lookaheads and lookbehinds are not allowed.");
});

Deno.test("checkPatternSafety rejects negative lookbehind", () => {
  const result = checkPatternSafety("(?<!foo)bar");
  assertEquals(result.valid, false);
});

// --- checkPatternSafety: length / complexity caps -----------------------

Deno.test("checkPatternSafety rejects a pattern over the length cap", () => {
  const longPattern = "a".repeat(300);
  const result = checkPatternSafety(longPattern);
  assertEquals(result.valid, false);
  assertEquals(result.reason, "Pattern exceeds the 256 character limit.");
});

Deno.test("checkPatternSafety accepts a pattern right at the length cap", () => {
  // 256 literal 'a' characters, no groups/quantifiers to trip the
  // complexity check — isolates the length boundary specifically.
  const pattern = "a".repeat(256);
  const result = checkPatternSafety(pattern);
  assertEquals(result.valid, true);
});

Deno.test("checkPatternSafety rejects an overly complex pattern", () => {
  // Many small non-nested capturing groups each with their own
  // quantifier, deliberately shaped to avoid tripping the nested-group or
  // alternation heuristics specifically (each group is independent, not
  // nested inside another quantified group), so this isolates the
  // complexity-score check: 12 groups + 12 quantifiers = 24, over the
  // threshold of 20.
  const pattern = Array.from({ length: 12 }, (_, i) => `(a${i})+`).join("");
  const result = checkPatternSafety(pattern);
  assertEquals(result.valid, false);
  assertEquals(result.reason, "Pattern is too complex (too many groups/quantifiers). Simplify it into a shorter pattern.");
});

// --- validateAnswerAgainstPattern ---------------------------------------

Deno.test("validateAnswerAgainstPattern matches a valid answer", () => {
  const result = validateAnswerAgainstPattern("Steve123", "^[A-Za-z0-9_]{3,16}$");
  assertEquals(result.valid, true);
});

Deno.test("validateAnswerAgainstPattern rejects a non-matching answer", () => {
  const result = validateAnswerAgainstPattern("!!invalid!!", "^[A-Za-z0-9_]{3,16}$");
  assertEquals(result.valid, false);
  assertEquals(result.reason, "no_match");
});

Deno.test("validateAnswerAgainstPattern rejects an answer over the length cap without running the regex", () => {
  const longAnswer = "a".repeat(5000);
  const result = validateAnswerAgainstPattern(longAnswer, "^a+$");
  assertEquals(result.valid, false);
  assertEquals(result.reason, "answer_too_long_for_pattern_check");
});

Deno.test("validateAnswerAgainstPattern matches an answer right at the length cap", () => {
  const answer = "a".repeat(4000);
  const result = validateAnswerAgainstPattern(answer, "^a+$");
  assertEquals(result.valid, true);
});
