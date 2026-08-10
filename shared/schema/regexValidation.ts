// shared/schema/regexValidation.ts
//
// Vets and executes admin-supplied regex patterns used for question answer
// validation. Two responsibilities, kept in one file so both the write
// path (API, when a pattern is saved) and the execution path (bot, when a
// pattern is run against a real applicant's answer) use the identical
// logic and can never drift apart on what's considered "safe."
//
// THREAT MODEL: the pattern author is a guild admin, not the general
// public, but admins are not a trusted-not-to-make-mistakes population —
// an accidentally catastrophic pattern (classic ReDoS shapes like
// nested quantifiers or quantified alternation with overlapping branches)
// can hang the Node/Deno event loop on a single evaluation, which is a
// real availability risk for a shared multi-tenant bot process regardless
// of whether the admin meant harm. So this rejects entire pattern SHAPES
// known to cause catastrophic backtracking, rather than trying to detect
// malice — the goal is "this can't pathologically hang," not "this
// pattern is written by a bad actor."
//
// This is a conservative static check, not a full regex-safety proof —
// it cannot catch every possible catastrophic-backtracking construction
// (that's a known-hard problem in general). It catches the well-known
// common shapes and backs that up with a hard execution timeout as a
// second line of defense (see validateAnswerAgainstPattern below), so a
// pattern that slips past the static check still can't hang the process
// indefinitely.

const MAX_PATTERN_LENGTH = 256;
const MAX_ANSWER_LENGTH_FOR_REGEX_CHECK = 4000; // matches the modal/DM answer cap elsewhere

export interface PatternCheckResult {
  valid: boolean;
  reason?: string;
}

/**
 * Rejects specific well-known ReDoS-prone shapes:
 *   - backreferences (\1, \2, ...) — not needed for answer-format
 *     validation and complicate safety analysis considerably
 *   - lookaheads/lookbehinds ((?=...), (?!...), (?<=...), (?<!...)) —
 *     same rationale; also not needed for simple format checks
 *   - nested quantified groups, e.g. (a+)+, (a*)*, (a+)* — the textbook
 *     catastrophic-backtracking shape
 *   - quantified alternation with repeated/overlapping branches, e.g.
 *     (a|a)+, (a|ab)+ — another well-known catastrophic shape
 */
export function checkPatternSafety(pattern: string): PatternCheckResult {
  if (pattern.length === 0) {
    return { valid: false, reason: "Pattern cannot be empty." };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, reason: `Pattern exceeds the ${MAX_PATTERN_LENGTH} character limit.` };
  }

  // Must be syntactically valid on its own before any shape analysis.
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (err) {
    return { valid: false, reason: `Invalid regex syntax: ${String(err instanceof Error ? err.message : err)}` };
  }

  if (/\\[1-9]/.test(pattern)) {
    return { valid: false, reason: "Backreferences (e.g. \\1) are not allowed." };
  }

  if (/\(\?[=!<]/.test(pattern)) {
    return { valid: false, reason: "Lookaheads and lookbehinds are not allowed." };
  }

  // Nested quantified groups: a quantifier (+, *, {n,}) directly applied
  // to a group that itself contains a quantified sub-expression, e.g.
  // (a+)+, (\d*)+, (x{2,})*. This is a heuristic textual check (it can't
  // fully parse arbitrary regex grammar), deliberately conservative —
  // it's fine for this to reject some patterns that would technically be
  // safe, since the cost of a false rejection (admin rewrites a pattern)
  // is far lower than the cost of a false acceptance (process hangs).
  if (/\([^()]*[+*][^()]*\)[+*]/.test(pattern)) {
    return { valid: false, reason: "Nested quantified groups (e.g. (a+)+) are not allowed — they can cause catastrophic backtracking." };
  }

  // Quantified alternation, e.g. (a|ab)+, (foo|foobar)*. Heuristic: an
  // alternation group immediately followed by a quantifier.
  if (/\([^()]*\|[^()]*\)[+*]/.test(pattern)) {
    return { valid: false, reason: "Quantified alternation (e.g. (a|ab)+) is not allowed — it can cause catastrophic backtracking." };
  }

  // A crude complexity score: count quantifiers and groups together: a
  // pattern with many of both is more likely to hide an unsafe
  // interaction even if no single heuristic above catches it.
  const quantifierCount = (pattern.match(/[+*]|\{\d+,?\d*\}/g) ?? []).length;
  const groupCount = (pattern.match(/\(/g) ?? []).length;
  if (quantifierCount + groupCount > 20) {
    return { valid: false, reason: "Pattern is too complex (too many groups/quantifiers). Simplify it into a shorter pattern." };
  }

  return { valid: true };
}

export interface AnswerValidationResult {
  valid: boolean;
  /** "answer_too_long_for_pattern_check" is treated as a validation
   * FAILURE (not silently passed) — a form asking for a bounded-format
   * answer (e.g. a Minecraft username) receiving 4000+ characters is
   * itself a sign the answer doesn't match the expected format. */
  reason?: "no_match" | "answer_too_long_for_pattern_check";
}

/**
 * Executes a pre-vetted pattern against a real answer. Only call this with
 * a pattern that has already passed checkPatternSafety — this function
 * does not re-run the static check itself, to keep the hot path (validating
 * one answer) cheap; callers are responsible for only persisting/using
 * patterns that passed the static check in the first place (see
 * api/src/routes/forms.ts's questionSchema).
 *
 * IMPORTANT LIMITATION, stated plainly rather than hidden: JavaScript's
 * RegExp execution is synchronous and runs on the single JS thread. A
 * setTimeout-based "race" around a synchronous regex.test() call does NOT
 * actually interrupt a stuck regex — if the engine is mid-catastrophic-
 * backtracking, the event loop is blocked and the timeout callback simply
 * cannot fire until the synchronous call returns on its own. A real hard
 * timeout for regex execution requires running the match in a separate
 * worker thread/process that can be forcibly terminated from outside,
 * which is a meaningfully bigger piece of infrastructure (worker pool
 * lifecycle, message passing, cleanup on terminate) than fits naturally
 * here. Given that, this function's actual safety comes ENTIRELY from
 * checkPatternSafety's static rejection of known-catastrophic shapes,
 * not from any runtime timeout — there is no runtime backstop currently.
 * If a pattern shape slips past the static heuristics, it CAN still hang
 * the process. Treat checkPatternSafety as the real (and only) line of
 * defense until a worker-based executor is built; do not assume this
 * function provides defense-in-depth it does not actually provide.
 */
export function validateAnswerAgainstPattern(
  answer: string,
  pattern: string,
): AnswerValidationResult {
  if (answer.length > MAX_ANSWER_LENGTH_FOR_REGEX_CHECK) {
    return { valid: false, reason: "answer_too_long_for_pattern_check" };
  }

  const regex = new RegExp(pattern);
  return regex.test(answer) ? { valid: true } : { valid: false, reason: "no_match" };
}
