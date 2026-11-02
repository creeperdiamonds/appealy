import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describeDiscordError, followHintFor, hintFor, isUnknownInteraction } from "../discordError.ts";

Deno.test("bare error keeps its message and finds nothing else", () => {
  const info = describeDiscordError(new Error("Failed to send request to discord."));
  assertEquals(info.status, null);
  assertEquals(info.code, null);
  assertEquals(info.message, "Failed to send request to discord.");
});

Deno.test("reads a JSON string body", () => {
  const err = Object.assign(new Error("Failed to send request to discord."), {
    body: '{"message":"Unknown interaction","code":10062}',
    status: 404,
  });
  const info = describeDiscordError(err);
  assertEquals(info.status, 404);
  assertEquals(info.code, 10062);
  assertEquals(info.message, "Unknown interaction");
});

Deno.test("reads an object body and a statusCode alias", () => {
  const err = Object.assign(new Error("Failed to send request to discord."), {
    body: { message: "Missing Permissions", code: 50013 },
    statusCode: 403,
  });
  const info = describeDiscordError(err);
  assertEquals(info.status, 403);
  assertEquals(info.code, 50013);
  assertEquals(info.message, "Missing Permissions");
});

Deno.test("follows the cause chain", () => {
  const inner = Object.assign(new Error("Unknown interaction"), { code: 10062 });
  const err = new Error("Failed to send request to discord.", { cause: inner });
  const info = describeDiscordError(err);
  assertEquals(info.code, 10062);
  assertEquals(info.message, "Unknown interaction");
});

Deno.test("prefers a specific message over the generic wrapper", () => {
  const err = Object.assign(new Error("Failed to send request to discord."), {
    body: { message: "Cannot send messages to this user", code: 50007 },
  });
  assertEquals(describeDiscordError(err).message, "Cannot send messages to this user");
});

Deno.test("survives a non-error", () => {
  assertEquals(describeDiscordError("boom").message, "boom");
  assertEquals(describeDiscordError(null).message, "null");
});

Deno.test("isUnknownInteraction only matches 10062", () => {
  assertEquals(isUnknownInteraction(describeDiscordError(Object.assign(new Error("x"), { code: 10062 }))), true);
  assertEquals(isUnknownInteraction(describeDiscordError(Object.assign(new Error("x"), { code: 50013 }))), false);
  assertEquals(isUnknownInteraction(describeDiscordError(new Error("x"))), false);
});

Deno.test("hintFor says what to do about a message that's gone", () => {
  const hint = hintFor({ status: 404, code: 10008, message: "Unknown Message" });
  assertEquals(hint, "That message no longer exists in Discord. Post it again to get a new one.");
});

Deno.test("hintFor stays quiet about a code it doesn't know", () => {
  assertEquals(hintFor({ status: 400, code: 12345, message: "Something else" }), undefined);
});

Deno.test("following a channel Appealy can't see asks for both permissions it needs", () => {
  const hint = followHintFor({ status: 403, code: 50001, message: "Missing Access" });
  assert(hint?.includes("View Channel"), hint);
  assert(hint?.includes("Manage Webhooks"), hint);
});

Deno.test("following without the permission names it", () => {
  const hint = followHintFor({ status: 403, code: 50013, message: "Missing Permissions" });
  assert(hint?.includes("Manage Webhooks"), hint);
});

Deno.test("following a deleted channel gets the general hint", () => {
  const info = { status: 404, code: 10003, message: "Unknown Channel" };
  assertEquals(followHintFor(info), hintFor(info));
  assert(hintFor(info)?.includes("no longer exists"));
});
