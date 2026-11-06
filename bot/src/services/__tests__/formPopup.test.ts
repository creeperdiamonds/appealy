// bot/src/services/__tests__/formPopup.test.ts
//
// Run with: deno test -c bot/deno.json bot/src/services/__tests__/formPopup.test.ts
//
// The application popup against Discord's limits. One value out of range and
// Discord refuses the whole popup, so the applicant can't apply at all.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildFormPopup, DEFAULT_CONFIRMATION, formIntro, usesPopupFlow, type PopupForm } from "../formPopup.ts";

const form = (over: Partial<PopupForm> = {}): PopupForm => ({
  id: "f1",
  name: "Media Application",
  description: "Apply to join the AshSMP Media team!",
  confirmationMessage: DEFAULT_CONFIRMATION,
  questions: [
    {
      id: "pos",
      label: "What position are you applying for?",
      type: "select",
      required: true,
      options: [{ label: "Media", value: "media" }, { label: "Streamer", value: "streamer" }],
    },
    { id: "link", label: "Link to your channel", type: "short_text", required: true },
    { id: "why", label: "What Strafe content would you make?", type: "paragraph", required: false },
  ],
  ...over,
});

type Comp = { type: number; label?: string; description?: string; content?: string; component?: Record<string, unknown> };

Deno.test("Media Application is one popup: description, then the dropdown and text boxes", () => {
  const popup = buildFormPopup(form(), 0);
  const c = popup.components as Comp[];
  assertEquals(popup.title, "Media Application");
  assertEquals(c.map((x) => x.type), [10, 18, 18, 18]);
  assertEquals(c[0].content, "Apply to join the AshSMP Media team!");
  assertEquals(c[1].component?.type, 3);
  assertEquals(c[1].component?.customId, "pos");
  assertEquals(c[2].component?.type, 4);
  assertEquals(c[3].component?.style, 2);
  assertEquals(c[3].component?.required, false);
  assertEquals(popup.customId.split(":").at(-1), "p0");
});

Deno.test("the default confirmation isn't shown, a custom one is", () => {
  assertEquals(formIntro(form({ description: null })), null);
  assertEquals(formIntro(form({ description: null, confirmationMessage: "Read the rules first." })), "Read the rules first.");
});

Deno.test("an optional dropdown can be left empty; a required one needs a pick", () => {
  const req = (buildFormPopup(form(), 0).components as Comp[])[1].component!;
  assertEquals([req.required, req.minValues], [true, 1]);
  const opt = (buildFormPopup(form({
    questions: [{ id: "s", label: "Pick", type: "select", required: false, options: [{ label: "A", value: "a" }] }],
  }), 0).components as Comp[])[1].component!;
  assertEquals([opt.required, opt.minValues], [false, 0]);
});

Deno.test("nothing in the popup exceeds Discord's limits", () => {
  const long = "x".repeat(300);
  const popup = buildFormPopup(form({
    name: long,
    questions: [
      { id: "s", label: long, type: "select", required: true, placeholder: long, options: Array.from({ length: 40 }, (_, i) => ({ label: long, value: `${long}${i}`, description: long })) },
      { id: "t", label: long, type: "short_text", required: true, placeholder: long, minLength: 9000, maxLength: 9000 },
    ],
  }), 0);
  assert(popup.title.length <= 45);
  for (const c of popup.components as Comp[]) {
    if (c.type !== 18) continue;
    assert(c.label!.length <= 45);
    assert(!c.description || c.description.length <= 100);
    const inner = c.component as Record<string, unknown> & { options?: { label: string; value: string; description?: string }[] };
    assert(!("label" in inner), "a text box in a Label has no label of its own");
    if (inner.type === 3) {
      assert((inner.placeholder as string).length <= 150);
      assert(inner.options!.length <= 25);
      for (const o of inner.options!) assert(o.label.length <= 100 && o.value.length <= 100 && (o.description ?? "").length <= 100);
    } else {
      assert((inner.placeholder as string).length <= 100);
      assert((inner.maxLength as number) <= 4000 && (inner.minLength as number) <= (inner.maxLength as number));
    }
  }
});

Deno.test("a page never holds more than five parts, and later pages have no intro", () => {
  const many = form({
    questions: Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, label: `Q${i}`, type: "short_text", required: true })),
  });
  for (let p = 0; p < 3; p++) {
    const popup = buildFormPopup(many, p);
    assert((popup.components as Comp[]).length <= 5);
    assert(popup.title.endsWith(`(${p + 1}/3)`) && popup.title.length <= 45);
    if (p > 0) assert(!(popup.components as Comp[]).some((c) => c.type === 10));
  }
});

Deno.test("forms the popup can't hold keep the older flow", () => {
  assert(usesPopupFlow(form()));
  // A dropdown with no choices: Discord refuses it.
  assert(!usesPopupFlow(form({ questions: [{ id: "s", label: "Pick", type: "select", required: true, options: [] }] })));
  // 25 questions plus a description is 26 places.
  assert(!usesPopupFlow(form({
    questions: Array.from({ length: 25 }, (_, i) => ({ id: `q${i}`, label: "Q", type: "short_text", required: true })),
  })));
  // No questions: nothing to show.
  assert(!usesPopupFlow(form({ questions: [] })));
  // Choice values are saved as the answer, so ones Discord would refuse can't be shortened.
  const choices = (values: string[]) =>
    form({ questions: [{ id: "s", label: "Pick", type: "select", required: true, options: values.map((v) => ({ label: v, value: v })) }] });
  assert(!usesPopupFlow(choices(["a", "a"])));
  assert(!usesPopupFlow(choices(["x".repeat(101)])));
  assert(!usesPopupFlow(choices(Array.from({ length: 26 }, (_, i) => `v${i}`))));
});
