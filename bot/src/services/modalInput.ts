// bot/src/services/modalInput.ts
//
// One application question as a Discord modal text input, inside every limit
// Discord enforces on modals.
//
// Discord rejects the WHOLE modal (400, code 50035 "Invalid Form Body") when
// any one input breaks a rule, and the applicant only sees "Something went
// wrong". The dashboard allows settings that are fine in the DM flow but not
// here (labels up to 200 characters), and some combinations it never checked
// (a minimum above the maximum, a maximum of 0). So every value is clamped
// here, at render time, rather than trusting the stored form: one awkward
// setting should cost a slightly shorter label, not the whole application.
// /apply failed this way on 2026-10-01.
//
// Free of env and network so it can be tested.

/** Discord's limits for a modal text input. */
export const MODAL_LIMITS = {
  label: 45,
  placeholder: 100,
  /** The most characters an answer can be, and so the ceiling for min and max. */
  value: 4000,
} as const;

export interface QuestionLike {
  label: string;
  placeholder?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
}

export interface ModalTextLimits {
  label: string;
  placeholder?: string;
  minLength?: number;
  maxLength: number;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.trunc(n)));
}

export function modalTextLimits(q: QuestionLike): ModalTextLimits {
  // A label is required and must not be empty.
  const label = clip(q.label.trim() || "Question", MODAL_LIMITS.label);
  const placeholder = q.placeholder?.trim() ? clip(q.placeholder.trim(), MODAL_LIMITS.placeholder) : undefined;
  // max_length has to be 1..4000; no maximum set means the most Discord allows.
  const maxLength = q.maxLength == null ? MODAL_LIMITS.value : clamp(q.maxLength, 1, MODAL_LIMITS.value);
  // min_length has to be 0..4000 and no more than the maximum. A minimum
  // above the maximum would make the question unanswerable anyway, so the
  // maximum wins.
  const minLength = q.minLength == null ? undefined : Math.min(clamp(q.minLength, 0, MODAL_LIMITS.value), maxLength);
  return { label, placeholder, minLength: minLength || undefined, maxLength };
}

/** Discord's limits for a Label around a question in a popup. */
export const LABEL_LIMITS = { label: 45, description: 100 } as const;

/**
 * A question as a Label's label and description.
 *
 * A text box's own label was cut at 45 characters, so a longer question lost
 * its end. A Label has a 100-character description as well, so the question
 * breaks at a word near 45 and carries on there: "What kind of Strafe content
 * would you make, and…" / "…how often could you post it?".
 */
export function modalLabel(text: string): { label: string; description?: string } {
  const t = text.trim().replace(/\s+/g, " ") || "Question";
  if (t.length <= LABEL_LIMITS.label) return { label: t };
  const space = t.lastIndexOf(" ", LABEL_LIMITS.label - 1);
  const at = space >= 20 ? space : LABEL_LIMITS.label - 1;
  return {
    label: `${t.slice(0, at).trimEnd()}…`,
    description: clip(`…${t.slice(at).trimStart()}`, LABEL_LIMITS.description),
  };
}
