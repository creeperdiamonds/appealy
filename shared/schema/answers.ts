// shared/schema/answers.ts
//
// Whether an answer meets its question's rules: required, length, pattern.
//
// The web appeal page (web/src/pages/WebAppeal.tsx) checks answers in the
// browser so people see problems as they type, and the bot checks them again
// before anything is saved (bot/src/services/webAppeal.ts), since a browser
// can be made to send anything. One function, so the two never disagree.
//
// The DM flow (bot/src/services/dmApplicationService.ts) checks one answer per
// message with its own wording, written for a chat reply rather than a field.

import { validateAnswerAgainstPattern } from "./regexValidation.ts";

export interface AnswerRules {
  required: boolean;
  minLength: number | null;
  maxLength: number | null;
  validationType: "none" | "regex";
  validationPattern: string | null;
  validationErrorMessage: string | null;
}

/** What's wrong with this answer, for the person typing it, or null. */
export function answerProblem(q: AnswerRules, value: string): string | null {
  const empty = value.trim().length === 0;
  if (empty) return q.required ? "This question needs an answer." : null;
  if (q.maxLength && value.length > q.maxLength) return `Keep it to ${q.maxLength} characters (now ${value.length}).`;
  if (q.minLength && value.length < q.minLength) return `Write at least ${q.minLength} characters (now ${value.length}).`;
  if (q.validationType === "regex" && q.validationPattern) {
    let ok = false;
    try {
      ok = validateAnswerAgainstPattern(value, q.validationPattern).valid;
    } catch {
      // A pattern the API let through but this engine can't compile. Not the
      // applicant's fault, and nothing they type will fix it.
      ok = true;
    }
    if (!ok) return q.validationErrorMessage || "That doesn't match the format this question asks for.";
  }
  return null;
}
