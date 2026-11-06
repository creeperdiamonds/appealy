// bot/src/services/__tests__/modalAnswers.test.ts
//
// Run with: deno test -c bot/deno.json bot/src/services/__tests__/modalAnswers.test.ts
//
// Reading answers out of a submitted popup, in both shapes it can arrive in:
// text boxes in action rows (popups built before Labels), and text boxes or
// dropdowns inside Labels. A shape this misses is an answer silently lost.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { labelComponentCustomizer, readModalAnswers } from "../modalAnswers.ts";

Deno.test("text boxes in action rows (the old popups)", () => {
  assertEquals(
    readModalAnswers([
      { type: 1, components: [{ type: 4, customId: "a", value: "one" }] },
      { type: 1, components: [{ type: 4, customId: "b", value: "" }] },
    ]),
    { a: "one", b: "" },
  );
});

Deno.test("text boxes and dropdowns inside Labels", () => {
  assertEquals(
    readModalAnswers([
      { type: 10 },
      { type: 18, component: { type: 4, customId: "a", value: "typed" } },
      { type: 18, component: { type: 3, customId: "b", values: ["media"] } },
      { type: 18, component: { type: 3, customId: "c", values: [] } },
    ]),
    { a: "typed", b: "media", c: "" },
  );
});

Deno.test("nothing usable gives nothing, without throwing", () => {
  assertEquals(readModalAnswers(undefined), {});
  assertEquals(readModalAnswers([undefined, { type: 10 }, { type: 18 }]), {});
});

Deno.test("the customizer keeps what Discordeno 20 drops from a Label and a select", () => {
  // Discordeno 20 has no case for Label (18) or Text Display (10), and its
  // select transform leaves out `values`. Without the customizer, a submitted
  // popup's Labels arrive as undefined and every answer is lost.
  const bot = {
    transformers: {
      component: (_b: unknown, p: { type: number; custom_id?: string; value?: string }) =>
        p.type === 4 ? { type: 4, customId: p.custom_id, value: p.value } : undefined,
    },
  };
  const select = labelComponentCustomizer(bot, { type: 3, custom_id: "s", values: ["x"] }, { type: 3, customId: "s" });
  assertEquals(select, { type: 3, customId: "s", values: ["x"] });

  const label = labelComponentCustomizer(
    bot,
    { type: 18, component: { type: 4, custom_id: "t", value: "hi" } },
    undefined,
  );
  assertEquals(label, { type: 18, component: { type: 4, customId: "t", value: "hi" } });

  assertEquals(labelComponentCustomizer(bot, { type: 10 }, undefined), { type: 10 });
  // Everything else passes through untouched.
  const button = { type: 2, customId: "b" };
  assertEquals(labelComponentCustomizer(bot, { type: 2 }, button), button);
});
