// shared/lib/__tests__/modalPaging.test.ts
//
// Run with: deno test shared/lib/__tests__/modalPaging.test.ts
//
// These guard the arithmetic behind a bug that lost people's answers without
// telling anyone. A form with more than five text questions used to be
// truncated at five: the applicant answered five, submitted what looked like
// a complete application, and questions six onward were never asked — nor was
// their `required` flag enforced, since on the modal path that is Discord's
// job and Discord never saw them.
//
// The off-by-one that matters most is isFinalPage. Wrong high, and the last
// page is never submitted; wrong low, and the daily submission cap is charged
// once per page instead of once per application.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cappedModalPageCount,
  isFinalPage,
  modalPageCount,
  modalPageSlice,
  MAX_MODAL_PAGES,
  MODAL_PAGE_SIZE,
} from "../modalPaging.ts";

Deno.test("a form with no text questions still has one page", () => {
  // Select-only forms reach the modal builder with an empty list. Zero pages
  // would mean never showing a modal, and so never submitting.
  assertEquals(modalPageCount(0), 1);
  assertEquals(cappedModalPageCount(0), 1);
});

Deno.test("five or fewer questions is one page", () => {
  for (const n of [1, 2, 4, 5]) {
    assertEquals(modalPageCount(n), 1, `${n} questions should be one page`);
  }
});

// The exact case that was silently truncated.
Deno.test("six questions is two pages", () => {
  assertEquals(modalPageCount(6), 2);
  assertEquals(modalPageSlice([1, 2, 3, 4, 5, 6], 0), [1, 2, 3, 4, 5]);
  assertEquals(modalPageSlice([1, 2, 3, 4, 5, 6], 1), [6]);
});

Deno.test("pages divide evenly with nothing dropped and nothing repeated", () => {
  const questions = Array.from({ length: 13 }, (_, i) => i);
  const pages = cappedModalPageCount(questions.length);
  assertEquals(pages, 3);

  const seen: number[] = [];
  for (let p = 0; p < pages; p++) seen.push(...modalPageSlice(questions, p));
  assertEquals(seen, questions);
});

Deno.test("no page ever exceeds Discord's five-component limit", () => {
  const questions = Array.from({ length: 25 }, (_, i) => i);
  for (let p = 0; p < cappedModalPageCount(questions.length); p++) {
    assertEquals(modalPageSlice(questions, p).length <= MODAL_PAGE_SIZE, true);
  }
});

Deno.test("the page ceiling holds", () => {
  // Above the ceiling the form is misconfigured; the ceiling stops an endless
  // click-through rather than pretending to serve it.
  assertEquals(cappedModalPageCount(1_000), MAX_MODAL_PAGES);
  assertEquals(modalPageCount(1_000) > MAX_MODAL_PAGES, true);
});

Deno.test("isFinalPage is true only on the last page", () => {
  // 11 questions -> 3 pages -> indices 0, 1, 2.
  assertEquals(isFinalPage(11, 0), false);
  assertEquals(isFinalPage(11, 1), false);
  assertEquals(isFinalPage(11, 2), true);
});

Deno.test("a single-page form is final immediately", () => {
  assertEquals(isFinalPage(3, 0), true);
  assertEquals(isFinalPage(5, 0), true);
  assertEquals(isFinalPage(0, 0), true);
});

// Belt and braces: a stale custom id from a form that has since had questions
// removed must still terminate rather than asking for a page that is not there.
Deno.test("a page index past the end is treated as final", () => {
  assertEquals(isFinalPage(6, 5), true);
  assertEquals(modalPageSlice([1, 2, 3], 9), []);
});

Deno.test("a form at exactly the ceiling ends on its last page", () => {
  const atCeiling = MODAL_PAGE_SIZE * MAX_MODAL_PAGES;
  assertEquals(cappedModalPageCount(atCeiling), MAX_MODAL_PAGES);
  assertEquals(isFinalPage(atCeiling, MAX_MODAL_PAGES - 1), true);
  assertEquals(isFinalPage(atCeiling, MAX_MODAL_PAGES - 2), false);
});
