// shared/lib/__tests__/transcript.test.ts
//
// Every case here is a defect that shipped. The renderer used to be four lines
// inline in ticketService.ts, where it could not be reached without a gateway
// connection and a real ticket, so none of this was ever exercised.

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderTranscript, type TranscriptMessage } from "../transcript.ts";

const AT = Date.parse("2026-09-08T09:00:00.000Z");

function msg(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { timestamp: AT, author: { username: "rin" }, content: "hello", ...over };
}

Deno.test("renders one line per message, oldest first, with an ISO timestamp", () => {
  const out = renderTranscript([msg({ content: "first" }), msg({ content: "second" })]);
  assertEquals(out.split("\n"), [
    "[2026-09-08T09:00:00.000Z] rin: first",
    "[2026-09-08T09:00:00.000Z] rin: second",
  ]);
});

Deno.test("an attachment-only message names the file instead of rendering blank", () => {
  // THE BUG: `content ?? ""` turned a screenshot — the most common thing in a
  // support ticket — into "rin: " with nothing after it.
  const out = renderTranscript([
    msg({ content: null, attachments: [{ filename: "proof.png" }] }),
  ]);
  assertStringIncludes(out, "[attached: proof.png]");
  assertEquals(out.endsWith(": "), false);
});

Deno.test("text and attachments appear together, not one instead of the other", () => {
  const out = renderTranscript([
    msg({ content: "here is the screenshot", attachments: [{ filename: "a.png" }, { filename: "b.png" }] }),
  ]);
  assertStringIncludes(out, "here is the screenshot");
  assertStringIncludes(out, "[attached: a.png, b.png]");
});

Deno.test("an embed-only message is recorded as an embed, not as silence", () => {
  const out = renderTranscript([msg({ content: "", embeds: [{}, {}] })]);
  assertStringIncludes(out, "[2 embeds]");
});

Deno.test("a message with nothing at all says so", () => {
  const out = renderTranscript([msg({ content: null, attachments: [], embeds: [] })]);
  assertStringIncludes(out, "[no content]");
});

Deno.test("an empty ticket does not produce an empty file", () => {
  assertEquals(renderTranscript([]), "(no messages)");
});

Deno.test("a truncated transcript admits it, at the top where it is read first", () => {
  // THE BUG: the fetch took the last 100 messages and said nothing. A partial
  // transcript that does not admit it is worse than no transcript.
  const out = renderTranscript([msg()], { truncated: true });
  assertStringIncludes(out, "*** TRUNCATED ***");
  assertEquals(out.startsWith("*** TRUNCATED ***"), true);
});

Deno.test("a complete transcript carries no truncation notice", () => {
  const out = renderTranscript([msg()]);
  assertEquals(out.includes("TRUNCATED"), false);
});

Deno.test("a missing author does not render as undefined", () => {
  const out = renderTranscript([msg({ author: null })]);
  assertStringIncludes(out, "unknown:");
  assertEquals(out.includes("undefined"), false);
});
