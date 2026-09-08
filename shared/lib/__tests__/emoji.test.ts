// shared/lib/__tests__/emoji.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { emojiForComponent, parseEmoji } from "../emoji.ts";

Deno.test("a unicode emoji passes through as a name", () => {
  assertEquals(parseEmoji("🎫"), { ok: true, emoji: { name: "🎫" } });
});

Deno.test("a custom emoji is split into id, name and animated", () => {
  // THE BUG: this arrived as { name: "<:ticket:123…>" }, which Discord cannot
  // render, and the dashboard documented it as a limitation instead of fixing
  // it. Pasting an emoji out of Discord is the obvious thing to do, so this is
  // the case people hit first.
  assertEquals(parseEmoji("<:ticket:1234567890123456789>"), {
    ok: true,
    emoji: { id: "1234567890123456789", name: "ticket", animated: false },
  });
});

Deno.test("an animated custom emoji is marked animated", () => {
  assertEquals(parseEmoji("<a:spin:1234567890123456789>"), {
    ok: true,
    emoji: { id: "1234567890123456789", name: "spin", animated: true },
  });
});

Deno.test("a bare id is accepted", () => {
  assertEquals(parseEmoji("1234567890123456789"), {
    ok: true,
    emoji: { id: "1234567890123456789" },
  });
});

Deno.test("a shortcode is rejected, with an explanation rather than silence", () => {
  // Discord converts :ticket: as you type in ITS box. A web form does not, so
  // the literal string was stored and the button published with an emoji that
  // rendered as nothing at all.
  const out = parseEmoji(":ticket:");
  assertEquals(out.ok, false);
  if (!out.ok) {
    assertEquals(out.reason, "shortcode");
    assertEquals(out.message.includes("shortcode"), true);
  }
});

Deno.test("empty is not an error — no emoji is a valid choice", () => {
  for (const v of ["", "   ", null, undefined]) {
    assertEquals(parseEmoji(v), { ok: true, emoji: undefined });
  }
});

Deno.test("surrounding whitespace does not defeat a custom emoji", () => {
  assertEquals(parseEmoji("  <:ticket:1234567890123456789>  ").ok, true);
  assertEquals(emojiForComponent(" 🎫 "), { name: "🎫" });
});

Deno.test("a malformed custom emoji is not silently treated as one", () => {
  // Too short an id, or a missing colon: taken as a literal rather than
  // producing an emoji object with a bogus id that Discord would 400 on.
  assertEquals(emojiForComponent("<:ticket:12>"), { name: "<:ticket:12>" });
});

Deno.test("emojiForComponent drops the unusable rather than throwing", () => {
  assertEquals(emojiForComponent(":ticket:"), undefined);
  assertEquals(emojiForComponent(null), undefined);
});
