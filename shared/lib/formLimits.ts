// shared/lib/formLimits.ts
//
// What limits how many questions a form may have.
//
// TWO SEPARATE LIMITS, AND CONFLATING THEM IS THE BUG THIS FILE PREVENTS.
//
//   questionsPerForm  A billed cap. Free 15, tier1 50, tier2 100, ceiling 200.
//                     Raising it is a purchase.
//
//   the modal ceiling MODAL_PAGE_SIZE * MAX_MODAL_PAGES = 25 TEXT questions on
//                     an `in_server` form. Discord's modals hold five
//                     components and the paging ceiling is five pages. This
//                     one is not for sale: no tier lifts it, because it is not
//                     ours to lift.
//
// A `direct_message` form is not subject to the second — dmApplicationService
// asks one question at a time — so a tier2 DM form really can have 100
// questions while a tier2 in-server form cannot ask past 25.
//
// This split exists because the alternative was already tried by accident.
// panelOpen.ts used to slice text questions at five and log a warning, so a
// form could hold questions the flow never asked and nobody was told. Selling
// a "100 questions" tier on top of that would have made a paid promise out of
// the same silence.

import { MAX_MODAL_PAGES, MODAL_PAGE_SIZE } from "./modalPaging.ts";

/** Text questions an `in_server` form can actually ask. Not tier-dependent. */
export const IN_SERVER_TEXT_QUESTION_CEILING = MODAL_PAGE_SIZE * MAX_MODAL_PAGES;

export type QuestionLimitViolation =
  | {
    kind: "tier_cap";
    /** Questions the form would have. */
    count: number;
    /** The guild's questionsPerForm. */
    limit: number;
  }
  | {
    kind: "modal_ceiling";
    /** TEXT questions the form would have; selects are not counted. */
    textCount: number;
    limit: number;
  };

export interface QuestionShape {
  /** Anything that is not "select" occupies a modal component. */
  type?: string | null;
}

/** Text questions among these — the ones that must fit in modals. */
export function countTextQuestions(questions: QuestionShape[]): number {
  return questions.filter((q) => q.type !== "select").length;
}

/**
 * Checks a form's questions against both limits.
 *
 * `previousCount` grandfathers, in the same shape as findRoleCapViolations:
 * a form that is already over a cap stays editable and may shrink, but must
 * never grow. Both caps arrived after forms existed, and refusing to save a
 * form somebody has been running for months — because of a limit introduced
 * underneath them — would be punishing the wrong person.
 *
 * Returns every violation rather than the first, so an over-cap in-server form
 * is told about both problems in one save instead of two.
 */
export function findQuestionLimitViolations(opts: {
  questions: QuestionShape[];
  /** The guild's questionsPerForm cap. */
  tierLimit: number;
  /** "in_server" or "direct_message". Only the former hits the modal ceiling. */
  applicationType: string | null | undefined;
  /** How many questions the form had before this edit; undefined when creating. */
  previousCount?: number;
  /** Text questions it had before. Undefined when creating. */
  previousTextCount?: number;
}): QuestionLimitViolation[] {
  const { questions, tierLimit, applicationType, previousCount, previousTextCount } = opts;
  const out: QuestionLimitViolation[] = [];

  const count = questions.length;
  if (count > tierLimit && !(previousCount !== undefined && count <= previousCount)) {
    out.push({ kind: "tier_cap", count, limit: tierLimit });
  }

  // Only in_server. A DM form is asked one question at a time and never builds
  // a modal, so the ceiling does not apply to it at all.
  if (applicationType !== "direct_message") {
    const textCount = countTextQuestions(questions);
    const grandfathered = previousTextCount !== undefined && textCount <= previousTextCount;
    if (textCount > IN_SERVER_TEXT_QUESTION_CEILING && !grandfathered) {
      out.push({
        kind: "modal_ceiling",
        textCount,
        limit: IN_SERVER_TEXT_QUESTION_CEILING,
      });
    }
  }

  return out;
}

/** A sentence for each violation, written for the admin rather than the log. */
export function describeQuestionViolation(v: QuestionLimitViolation): string {
  if (v.kind === "tier_cap") {
    return `This form has ${v.count} questions, above the ${v.limit} your plan allows. ` +
      `Remove some, or move to a higher tier.`;
  }
  return `This form has ${v.textCount} text questions. An in-server application can only ask ` +
    `${v.limit} of them — Discord modals hold ${MODAL_PAGE_SIZE} components and Appealy pages ` +
    `them ${MAX_MODAL_PAGES} deep. No tier raises this, because the limit is Discord's. ` +
    `Switch the form to DM delivery, which asks one question at a time and has no such limit, ` +
    `or remove some questions.`;
}
