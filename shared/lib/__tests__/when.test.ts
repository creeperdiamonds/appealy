// shared/lib/__tests__/when.test.ts
//
// Run with: deno test shared/lib/__tests__/when.test.ts
//
// The parser behind "when should this close?". It reads text a person typed
// in a channel, so the interesting cases are the ones where a plausible
// misreading is worse than a refusal: "10 july" read as ten of something,
// "3m" read as three months, a poll silently closing before its announced
// time because hours were rounded down.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseWhen, toNativePollHours } from "../when.ts";

/** A fixed instant, so "july 10" resolves the same way in every month. */
const NOW = new Date("2026-03-15T12:00:00.000Z");

function at(input: string): Date {
  const r = parseWhen(input, NOW);
  if (!r.ok) throw new Error(`expected "${input}" to parse, got: ${r.reason}`);
  return r.at;
}

function failureOf(input: string): string {
  const r = parseWhen(input, NOW);
  if (r.ok) throw new Error(`expected "${input}" to fail, got ${r.at.toISOString()}`);
  return r.reason;
}

const MIN = 60_000;
const HOUR = 3_600_000;

Deno.test("the example from the request: 1h 20m", () => {
  assertEquals(at("1h 20m").getTime() - NOW.getTime(), HOUR + 20 * MIN);
});

Deno.test("the example from the request: 10 hours 50 minutes", () => {
  assertEquals(at("10 hours 50 minutes").getTime() - NOW.getTime(), 10 * HOUR + 50 * MIN);
});

Deno.test("the example from the request: july 10", () => {
  assertEquals(at("july 10").toISOString(), "2026-07-10T00:00:00.000Z");
});

Deno.test("spacing and spelling of units does not matter", () => {
  const expected = HOUR + 20 * MIN;
  for (const input of ["1h20m", "1h 20m", "1 hour 20 minutes", "1hr 20min", "1 h 20 m"]) {
    assertEquals(at(input).getTime() - NOW.getTime(), expected, input);
  }
});

Deno.test("connectives people actually type are ignored", () => {
  assertEquals(at("1 day and 2 hours").getTime() - NOW.getTime(), 26 * HOUR);
  assertEquals(at("1d, 2h").getTime() - NOW.getTime(), 26 * HOUR);
});

Deno.test("case is irrelevant", () => {
  assertEquals(at("JULY 10").toISOString(), "2026-07-10T00:00:00.000Z");
  assertEquals(at("2D").getTime() - NOW.getTime(), 48 * HOUR);
});

// m is minutes. Three months would be a genuinely bad surprise on a poll.
Deno.test("m means minutes, never months", () => {
  assertEquals(at("3m").getTime() - NOW.getTime(), 3 * MIN);
});

// The case the relative grammar must NOT swallow.
Deno.test("10 july is a date, not ten of something", () => {
  assertEquals(at("10 july").toISOString(), "2026-07-10T00:00:00.000Z");
});

Deno.test("a bare date with no year picks the next occurrence", () => {
  // March 15 is the clock; January has gone, so january 5 is next year.
  assertEquals(at("january 5").toISOString(), "2027-01-05T00:00:00.000Z");
  // July has not.
  assertEquals(at("july 10").getUTCFullYear(), 2026);
});

Deno.test("ISO dates parse, with and without a time", () => {
  assertEquals(at("2026-07-10").toISOString(), "2026-07-10T00:00:00.000Z");
  assertEquals(at("2026-07-10 14:30").toISOString(), "2026-07-10T14:30:00.000Z");
});

Deno.test("times attach to dates in the forms people write them", () => {
  assertEquals(at("july 10 14:30").toISOString(), "2026-07-10T14:30:00.000Z");
  assertEquals(at("july 10 at 14:30").toISOString(), "2026-07-10T14:30:00.000Z");
  assertEquals(at("july 10 2pm").toISOString(), "2026-07-10T14:00:00.000Z");
  assertEquals(at("july 10 12am").toISOString(), "2026-07-10T00:00:00.000Z");
  assertEquals(at("july 10 12pm").toISOString(), "2026-07-10T12:00:00.000Z");
});

Deno.test("a trailing word is refused rather than ignored", () => {
  // "1h banana" must not quietly become one hour.
  failureOf("1h banana");
  failureOf("tomorrow");
});

Deno.test("nonsense is refused with advice, not a stack trace", () => {
  const reason = failureOf("sometime next week probably");
  assertEquals(reason.includes("1h 20m"), true);
});

Deno.test("a date that does not exist is refused, not rolled over", () => {
  // Date.UTC(2026, 8, 31) silently becomes 1 October.
  failureOf("september 31");
  failureOf("february 30");
});

Deno.test("the past is refused", () => {
  failureOf("2026-01-01");
});

Deno.test("absurd distances are refused", () => {
  failureOf("400d");
  failureOf("2099-01-01");
});

Deno.test("empty input is refused", () => {
  failureOf("");
  failureOf("   ");
});

Deno.test("kind reports which grammar matched", () => {
  const rel = parseWhen("2h", NOW);
  const abs = parseWhen("july 10", NOW);
  assertEquals(rel.ok && rel.kind, "relative");
  assertEquals(abs.ok && abs.kind, "absolute");
});

// ---------------------------------------------------------------------------
// Native poll rounding. Discord takes whole hours, 1..768, and nothing finer.
// ---------------------------------------------------------------------------

Deno.test("an exact hour count is not reported as rounded", () => {
  const r = toNativePollHours(new Date(NOW.getTime() + 5 * HOUR), NOW);
  assertEquals(r, { hours: 5, rounded: false });
});

// Rounding UP: closing early would end a poll before the time its author
// announced, which is worse than running slightly long.
Deno.test("1h 20m rounds up to 2 hours and says so", () => {
  const r = toNativePollHours(new Date(NOW.getTime() + HOUR + 20 * MIN), NOW);
  assertEquals(r, { hours: 2, rounded: true });
});

Deno.test("under an hour still gets Discord's minimum of one", () => {
  const r = toNativePollHours(new Date(NOW.getTime() + 5 * MIN), NOW);
  assertEquals(r, { hours: 1, rounded: true });
});

Deno.test("Discord's 32-day ceiling is respected", () => {
  assertEquals(toNativePollHours(new Date(NOW.getTime() + 768 * HOUR), NOW), {
    hours: 768,
    rounded: false,
  });
  // Beyond it there is no native poll to create — the caller must say so
  // rather than silently clamping to 32 days.
  assertEquals(toNativePollHours(new Date(NOW.getTime() + 769 * HOUR), NOW), null);
});

Deno.test("a time already past has no native duration", () => {
  assertEquals(toNativePollHours(new Date(NOW.getTime() - HOUR), NOW), null);
});
