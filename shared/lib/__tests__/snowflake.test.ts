// shared/lib/__tests__/snowflake.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isSnowflake, onlySnowflakes } from "../snowflake.ts";

Deno.test("a Discord ID counts", () => {
  assertEquals(isSnowflake("1511370279312429097"), true);
});

Deno.test("what people have really typed into the ID boxes doesn't", () => {
  // Production's logs have shown role names, channel names and pasted links.
  for (const typed of ["Moderators", "Welcome", "https://discord.com/channels/1/2", "@Staff", "", "123"]) {
    assertEquals(isSnowflake(typed), false, typed);
  }
});

Deno.test("onlySnowflakes keeps the IDs, in order, and drops the rest", () => {
  assertEquals(
    onlySnowflakes(["1511370279312429097", "Moderators", "1200000000000000000"]),
    ["1511370279312429097", "1200000000000000000"],
  );
});
