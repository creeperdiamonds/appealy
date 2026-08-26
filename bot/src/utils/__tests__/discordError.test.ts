import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describeDiscordError, isUnknownInteraction } from "../discordError.ts";

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
