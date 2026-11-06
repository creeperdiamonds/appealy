// shared/lib/__tests__/formModalLayout.test.ts
//
// Run with: deno test shared/lib/__tests__/formModalLayout.test.ts
//
// The layout of a form whose every question, choices included, is in the
// popup itself. The builder and the submit handler both work out the pages
// from this, so they agree on which page is the last: wrong high and the last
// page never submits; wrong low and the application is cut short.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fitsInOnePopupFlow, popupPages, isFinalPopupPage } from "../modalPaging.ts";

const q = (n: number) => Array.from({ length: n }, (_, i) => `q${i + 1}`);

Deno.test("the intro takes one of the first page's five places", () => {
  assertEquals(popupPages(q(5), true), [["q1", "q2", "q3", "q4"], ["q5"]]);
  assertEquals(popupPages(q(4), true), [["q1", "q2", "q3", "q4"]]);
});

Deno.test("without an intro, five a page", () => {
  assertEquals(popupPages(q(5), false), [["q1", "q2", "q3", "q4", "q5"]]);
  assertEquals(popupPages(q(6), false), [["q1", "q2", "q3", "q4", "q5"], ["q6"]]);
});

Deno.test("a form fits while questions and intro come to 25 or fewer", () => {
  assert(fitsInOnePopupFlow(25, false));
  assert(!fitsInOnePopupFlow(26, false));
  assert(fitsInOnePopupFlow(24, true));
  assert(!fitsInOnePopupFlow(25, true));
  // No questions: nothing to put in a popup.
  assert(!fitsInOnePopupFlow(0, true));
});

Deno.test("every question lands on exactly one page, in order", () => {
  for (const intro of [true, false]) {
    for (let n = 1; n <= 25 - (intro ? 1 : 0); n++) {
      const pages = popupPages(q(n), intro);
      assertEquals(pages.flat(), q(n), `n=${n} intro=${intro}`);
      assert(pages.length <= 5);
      pages.forEach((p, i) => assert(p.length + (intro && i === 0 ? 1 : 0) <= 5));
    }
  }
});

Deno.test("the final page is the last one the layout makes", () => {
  assert(isFinalPopupPage(4, true, 0));
  assert(!isFinalPopupPage(5, true, 0));
  assert(isFinalPopupPage(5, true, 1));
  assert(isFinalPopupPage(5, false, 0));
  assert(!isFinalPopupPage(6, false, 0));
});
