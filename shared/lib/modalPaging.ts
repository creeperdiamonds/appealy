// shared/lib/modalPaging.ts
//
// How a form's text questions divide across Discord modals.
//
// A modal holds at most five components. That is a protocol limit, not a
// design choice, and the only real question is what happens to question six.
// It used to be `textQuestions.slice(0, 5)` plus a logger.warn: the applicant
// saw five, submitted what looked like a finished application, and the rest
// were never asked. Their `required` flag went with them — on that path
// required-ness is enforced only by Discord's own `required:` on the text
// input, and nothing server-side re-checks it. The single trace was a warning
// line in the bot's logs.
//
// Lives in shared/ rather than beside the modal builder for two reasons: the
// submit handler and the modal builder both need it, and importing either of
// those pulls in a database client, which would put this arithmetic out of
// reach of `deno test`.

/** Discord's hard limit on components in one modal. */
export const MODAL_PAGE_SIZE = 5;

/**
 * Ceiling on pages per application.
 *
 * Twenty-five text questions is already a long application; past that the
 * form is the problem and an endless click-through is not the answer to it.
 * A form above this is still truncated — but at a bounded, reported point,
 * rather than silently at five.
 */
export const MAX_MODAL_PAGES = 5;

/** Pages a form's text questions need, before the ceiling. Always at least one. */
export function modalPageCount(textQuestionCount: number): number {
  return Math.max(1, Math.ceil(textQuestionCount / MODAL_PAGE_SIZE));
}

/** Pages actually shown, after the ceiling. */
export function cappedModalPageCount(textQuestionCount: number): number {
  return Math.min(modalPageCount(textQuestionCount), MAX_MODAL_PAGES);
}

/** The text questions shown on one page. */
export function modalPageSlice<T>(textQuestions: T[], page: number): T[] {
  return textQuestions.slice(page * MODAL_PAGE_SIZE, (page + 1) * MODAL_PAGE_SIZE);
}

/** Whether a submit of this page completes the application. */
export function isFinalPage(textQuestionCount: number, page: number): boolean {
  return page + 1 >= cappedModalPageCount(textQuestionCount);
}
