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
// Timezones typed after the time. Resolution itself is covered in
// timezones.test.ts; these check that it reaches the answer.
// ---------------------------------------------------------------------------

Deno.test("an offset shifts the resolved instant", () => {
  // 3pm at UTC+5:30 is 09:30 UTC.
  assertEquals(at("july 10 3pm UTC+5:30").toISOString(), "2026-07-10T09:30:00.000Z");
  // ...and 20:00 UTC at UTC-5.
  assertEquals(at("july 10 3pm UTC-5").toISOString(), "2026-07-10T20:00:00.000Z");
});

Deno.test("abbreviations reach the answer", () => {
  assertEquals(at("july 10 3pm EST").toISOString(), "2026-07-10T20:00:00.000Z");
  assertEquals(at("july 10 3pm JST").toISOString(), "2026-07-10T06:00:00.000Z");
});

Deno.test("countries and cities reach the answer", () => {
  assertEquals(at("july 10 3pm india").toISOString(), "2026-07-10T09:30:00.000Z");
  assertEquals(at("july 10 3pm tokyo").toISOString(), "2026-07-10T06:00:00.000Z");
});

// The zone is resolved at the target date, not today's, so a July close time
// typed in March gets New York's summer offset rather than its winter one.
Deno.test("a named zone uses the offset in force on the target date", () => {
  // NOW is 15 March 2026. America/New_York is -4 in July, -5 in January.
  assertEquals(at("july 10 3pm America/New_York").toISOString(), "2026-07-10T19:00:00.000Z");
  assertEquals(at("2027-01-10 3pm America/New_York").toISOString(), "2027-01-10T20:00:00.000Z");
});

Deno.test("no zone means UTC, unchanged from before", () => {
  assertEquals(at("july 10 14:30").toISOString(), "2026-07-10T14:30:00.000Z");
  const r = parseWhen("july 10 14:30", NOW);
  assertEquals(r.ok && r.zone, undefined);
});

Deno.test("a recognised zone is reported back for echoing", () => {
  const r = parseWhen("july 10 3pm india", NOW);
  assertEquals(r.ok && r.zone, "India");
  assertEquals(r.ok && r.offsetMinutes, 330);
});

// The whole point. Silently picking India would move the close time four and
// a half hours.
Deno.test("an ambiguous zone becomes a question, not a rejection", () => {
  const r = parseWhen("july 10 3pm IST", NOW);
  if (r.ok) throw new Error("expected IST to be ambiguous");
  assertEquals(r.reason.includes("India"), true);
  // The structured part is what lets the caller ask instead of giving up.
  assertEquals(r.ambiguity?.phrase, "IST");
  assertEquals(r.ambiguity?.body, "july 10 3pm");
  assertEquals(r.ambiguity?.choices.map((c) => c.label), ["India", "Ireland", "Israel"]);
});

// The contract that makes asking safe: the answer goes back through the same
// grammar rather than a second code path that could disagree with it.
Deno.test("re-parsing body plus a chosen zone resolves", () => {
  const r = parseWhen("july 10 3pm IST", NOW);
  if (r.ok || !r.ambiguity) throw new Error("expected ambiguity");

  const india = r.ambiguity.choices.find((c) => c.label === "India")!;
  assertEquals(at(`${r.ambiguity.body} ${india.value}`).toISOString(), "2026-07-10T09:30:00.000Z");

  const ireland = r.ambiguity.choices.find((c) => c.label === "Ireland")!;
  // July, so Ireland is UTC+1 — 3pm there is 14:00 UTC.
  assertEquals(at(`${r.ambiguity.body} ${ireland.value}`).toISOString(), "2026-07-10T14:00:00.000Z");
});

Deno.test("a country spanning several offsets asks with real zones", () => {
  const r = parseWhen("july 10 3pm united states", NOW);
  if (r.ok) throw new Error("expected the US to be ambiguous");
  assertEquals(r.ambiguity !== undefined, true);
  assertEquals(r.ambiguity!.choices.every((c) => c.value.includes("/")), true);
  assertEquals(r.ambiguity!.body, "july 10 3pm");
});

// Only a timezone question carries choices; there is no menu of alternatives
// for a date that does not exist.
Deno.test("other failures carry no choices", () => {
  const r = parseWhen("september 31", NOW);
  if (r.ok) throw new Error("expected failure");
  assertEquals(r.ambiguity, undefined);
});

// A duration is the same length everywhere, so a zone on one is meaningless
// rather than wrong — honoured, not refused.
Deno.test("a duration with a zone stuck on it still parses", () => {
  assertEquals(at("2h EST").getTime() - NOW.getTime(), 2 * HOUR);
  assertEquals(at("1h 20m india").getTime() - NOW.getTime(), HOUR + 20 * MIN);
});

// The regression the zone splitter could easily cause.
Deno.test("splitting a zone off does not eat part of the date", () => {
  assertEquals(at("july 10").toISOString(), "2026-07-10T00:00:00.000Z");
  assertEquals(at("10 july").toISOString(), "2026-07-10T00:00:00.000Z");
  assertEquals(at("2026-07-10").toISOString(), "2026-07-10T00:00:00.000Z");
});

// An offset can push the instant onto a different UTC date; the "does this
// date exist" check must run on what was typed, not on the converted instant.
Deno.test("a date near midnight survives an offset that moves it", () => {
  // 2am on 10 July at UTC+5:30 is 20:30 on 9 July UTC.
  assertEquals(at("july 10 2am UTC+5:30").toISOString(), "2026-07-09T20:30:00.000Z");
});

Deno.test("an unrecognised trailing word is still refused", () => {
  failureOf("july 10 3pm banana");
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
