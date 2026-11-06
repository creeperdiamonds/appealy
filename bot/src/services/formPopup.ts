// bot/src/services/formPopup.ts
//
// An in-server application as a real popup: the form's description at the
// top, then every question in order, dropdowns included. See the note above
// fitsInOnePopupFlow in shared/lib/modalPaging.ts for why this replaced the
// Continue message and the dropdown-in-a-message steps.
//
// Builds the popup's data and nothing else, so it can be checked against
// Discord's limits in a test. Discord rejects the WHOLE popup for one value
// out of range, and the applicant only sees "Something went wrong", so every
// field is clipped here rather than trusted from the stored form.

import { encodeCustomId } from "../../../shared/types/index.ts";
import { fitsInOnePopupFlow, popupPages } from "../../../shared/lib/modalPaging.ts";
import { modalLabel, modalTextLimits } from "./modalInput.ts";

/** What forms.confirmationMessage holds when nobody changed it (shared/schema/schema.ts). */
export const DEFAULT_CONFIRMATION =
  "Are you sure you want to apply? Once you start, you'll be asked a series of questions.";

export interface PopupQuestion {
  id: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  options?: { label: string; value: string; description?: string }[] | null;
}

export interface PopupForm {
  id: string;
  name: string;
  description?: string | null;
  confirmationMessage?: string | null;
  questions: PopupQuestion[];
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The words at the top of the first page, or null for none. */
export function formIntro(form: PopupForm): string | null {
  const confirmation = form.confirmationMessage?.trim();
  const parts = [
    form.description?.trim() || null,
    // The default reads "once you start, you'll be asked…": true before a
    // Continue button, odd at the top of the questions themselves.
    confirmation && confirmation !== DEFAULT_CONFIRMATION ? confirmation : null,
  ].filter(Boolean);
  return parts.length ? clip(parts.join("\n\n"), 2000) : null;
}

/**
 * Whether this form can be one popup flow. Not when it needs more than five
 * pages, and not when a dropdown has no choices (Discord refuses an empty
 * one): those keep the older flow, which handles both.
 */
export function usesPopupFlow(form: PopupForm): boolean {
  // A dropdown's values are what gets saved as the answer, so they can't be
  // shortened to fit; one Discord would refuse keeps the older flow too.
  const badChoices = form.questions.some((q) => {
    if (q.type !== "select") return false;
    const values = (q.options ?? []).map((o) => o.value || o.label || "option");
    return values.length === 0 || values.length > 25 || values.some((v) => v.length > 100) ||
      new Set(values).size !== values.length;
  });
  return !badChoices && fitsInOnePopupFlow(form.questions.length, formIntro(form) !== null);
}

export function popupPageCount(form: PopupForm): number {
  return popupPages(form.questions, formIntro(form) !== null).length;
}

/** The custom id's page marker for this flow; "p" tells it apart from the older one's bare number. */
export const popupPageTag = (page: number) => `p${page}`;

/** The popup for one page, ready to send as a type 9 response's data. */
export function buildFormPopup(form: PopupForm, page: number) {
  const intro = formIntro(form);
  const pages = popupPages(form.questions, intro !== null);
  const questions = pages[page] ?? [];
  const title = pages.length > 1
    ? `${clip(form.name.trim() || "Application", 45 - ` (${page + 1}/${pages.length})`.length)} (${page + 1}/${pages.length})`
    : clip(form.name.trim() || "Application", 45);

  const components: Record<string, unknown>[] = [];
  if (page === 0 && intro) components.push({ type: 10, content: intro });

  for (const q of questions) {
    if (q.type === "select") {
      components.push({
        type: 18,
        ...modalLabel(q.label),
        component: {
          type: 3,
          customId: q.id,
          placeholder: clip(q.placeholder?.trim() || "Choose one", 150),
          required: q.required,
          // Discord: min_values at least 1 unless the select is optional.
          minValues: q.required ? 1 : 0,
          maxValues: 1,
          options: (q.options ?? []).slice(0, 25).map((o) => ({
            label: clip(o.label || o.value || "Option", 100),
            value: clip(o.value || o.label || "option", 100),
            ...(o.description ? { description: clip(o.description, 100) } : {}),
          })),
        },
      });
    } else {
      // The text box's own label is replaced by the Label around it.
      const { label: _label, ...limits } = modalTextLimits(q);
      components.push({
        type: 18,
        ...modalLabel(q.label),
        component: {
          type: 4,
          customId: q.id,
          style: q.type === "paragraph" ? 2 : 1,
          required: q.required,
          ...limits,
        },
      });
    }
  }

  return {
    customId: encodeCustomId("modal", "submit", form.id, popupPageTag(page)),
    title,
    components,
  };
}
