import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatLogLine } from "../logger.ts";

Deno.test("an error object is logged with Discord's reason, not just the wrapper sentence", () => {
  const err = Object.assign(new Error("Failed to send request to discord."), {
    cause: { ok: false, status: 403, body: '{"message":"Missing Permissions","code":50013}' },
  });
  const line = JSON.parse(formatLogLine("warn", "Couldn't post", { error: err }));
  assertEquals(line.error, "Missing Permissions");
  assertEquals(line.status, 403);
  assertEquals(line.code, 50013);
});

Deno.test("a plain error keeps its message, and fields already given are not overwritten", () => {
  const line = JSON.parse(formatLogLine("error", "x", { error: new Error("boom"), code: 7 }));
  assertEquals(line.error, "Error: boom");
  assertEquals(line.code, 7);
});

Deno.test("strings and other values pass through unchanged", () => {
  const line = JSON.parse(formatLogLine("info", "x", { error: "already a string", n: 1 }));
  assertEquals(line.error, "already a string");
  assertEquals(line.n, 1);
});
