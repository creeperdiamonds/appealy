// shared/lib/__tests__/bigJson.test.ts
//
// Discord ids read through drizzle's nested rows were rounded by JSON.parse
// (see ../bigJson.ts). These pin that they now come back exact, and that
// nothing else in the JSON changes.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseJsonKeepingBigIntegers, quoteBigIntegers } from "../bigJson.ts";

Deno.test("a snowflake survives exactly, as a string", () => {
  const row = parseJsonKeepingBigIntegers('[["abc", 1489336236060447014, null]]') as unknown[][];
  assertEquals(row[0][1], "1489336236060447014");
  assertEquals(BigInt(row[0][1] as string), 1489336236060447014n);
});

Deno.test("ordinary numbers, booleans and nulls are untouched", () => {
  assertEquals(parseJsonKeepingBigIntegers('[1, -2, 3.5, 1e3, 9007199254740991, true, null]'), [1, -2, 3.5, 1e3, 9007199254740991, true, null]);
});

Deno.test("digits inside strings are left alone, escapes included", () => {
  const text = '["1489336236060447014", "say \\"1489336236060447014\\"", 1489336236060447014]';
  assertEquals(quoteBigIntegers(text), '["1489336236060447014", "say \\"1489336236060447014\\"", "1489336236060447014"]');
});

Deno.test("negative big integers and nested objects", () => {
  assertEquals(parseJsonKeepingBigIntegers('{"a": {"b": [-1489336236060447014]}}'), { a: { b: ["-1489336236060447014"] } });
});
