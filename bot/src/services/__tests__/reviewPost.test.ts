// bot/src/services/__tests__/reviewPost.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resendableEmbed } from "../reviewPost.ts";

// The shape Discordeno hands back (transformers/embed.js): timestamp parsed
// to milliseconds, plus fields Discord fills in itself. Sent back as-is,
// Discord rejected every review-post edit.
Deno.test("a read-back embed is made sendable again", () => {
  const ms = Date.parse("2026-10-07T10:26:00.000Z");
  const out = resendableEmbed({
    title: "New Application — Media & Production",
    timestamp: ms,
    type: "rich",
    video: undefined,
    provider: undefined,
    fields: [{ name: "Q", value: "test", inline: false }],
    footer: { text: "Submission ID: x" },
  });
  assertEquals(out.timestamp, "2026-10-07T10:26:00.000Z");
  assertEquals("type" in out, false);
  assertEquals(out.title, "New Application — Media & Production");
  assertEquals((out.fields as unknown[]).length, 1, "the answers survive");
});

Deno.test("nothing to copy gives an empty embed, and a string timestamp is left alone", () => {
  assertEquals(resendableEmbed(undefined), {});
  assertEquals(resendableEmbed({ timestamp: "2026-10-07T10:26:00.000Z" }).timestamp, "2026-10-07T10:26:00.000Z");
});
