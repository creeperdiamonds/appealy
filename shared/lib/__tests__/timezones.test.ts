// shared/lib/__tests__/timezones.test.ts
//
// Run with: deno test shared/lib/__tests__/timezones.test.ts
//
// The rule under test is the one the module exists for: a spelling that could
// mean more than one offset is refused with the options, never resolved to
// whichever is most common. A poll told to close at "3pm IST" that closes
// four and a half hours early because India was assumed is a worse outcome
// than being asked which IST was meant.
//
// The second rule is the one that keeps that from being pedantic: ambiguity
// is measured in OFFSETS, not in names. Germany has two IANA zones that have
// agreed for decades, and asking someone to choose between Europe/Berlin and
// Europe/Busingen would be useless.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  formatOffset,
  offsetForCandidate,
  offsetMinutesAt,
  resolveZone,
  type ZoneCandidate,
} from "../timezones.ts";

const JAN = new Date("2026-01-15T12:00:00.000Z");
const JUL = new Date("2026-07-15T12:00:00.000Z");

/** Resolves and flattens to minutes, asserting it was not ambiguous. */
function minutesFor(phrase: string, at: Date): number {
  const c = resolveZone(phrase);
  if (!c) throw new Error(`"${phrase}" resolved to nothing`);
  if ("options" in c) throw new Error(`"${phrase}" was ambiguous: ${c.options.join(", ")}`);
  const r = offsetForCandidate(c, at);
  if ("disagree" in r) {
    throw new Error(`"${phrase}" disagreed: ${r.disagree.map((d) => d.zone).join(", ")}`);
  }
  return r.minutes;
}

function isAmbiguous(phrase: string): boolean {
  const c = resolveZone(phrase);
  if (!c) return false;
  if ("options" in c) return true;
  return "disagree" in offsetForCandidate(c, JAN);
}

// ---------------------------------------------------------------- offsets

Deno.test("explicit offsets parse in the spellings people use", () => {
  assertEquals(minutesFor("UTC+5", JAN), 300);
  assertEquals(minutesFor("GMT-8", JAN), -480);
  assertEquals(minutesFor("UTC+05:30", JAN), 330);
  assertEquals(minutesFor("utc+5:30", JAN), 330);
  assertEquals(minutesFor("+0530", JAN), 330);
  assertEquals(minutesFor("-05:00", JAN), -300);
});

Deno.test("UTC and GMT alone are zero", () => {
  assertEquals(minutesFor("UTC", JAN), 0);
  assertEquals(minutesFor("gmt", JAN), 0);
  assertEquals(minutesFor("Z", JAN), 0);
});

Deno.test("offsets outside the real range are rejected", () => {
  assertEquals(resolveZone("UTC+27"), null);
  assertEquals(resolveZone("UTC+15"), null); // real max is +14
});

// ----------------------------------------------------------- abbreviations

Deno.test("unambiguous abbreviations resolve", () => {
  assertEquals(minutesFor("EST", JAN), -300);
  assertEquals(minutesFor("PST", JAN), -480);
  assertEquals(minutesFor("CET", JAN), 60);
  assertEquals(minutesFor("JST", JAN), 540);
  assertEquals(minutesFor("AEST", JAN), 600);
  assertEquals(minutesFor("nzst", JAN), 720);
});

// The headline case. IST is India, Ireland and Israel, hours apart.
Deno.test("IST is refused, not guessed", () => {
  const c = resolveZone("IST");
  assertEquals(c !== null && "options" in c, true);
  const options = (c as { options: string[] }).options;
  assertEquals(options.length >= 3, true);
  assertEquals(options.some((o) => o.includes("India")), true);
  assertEquals(options.some((o) => o.includes("Ireland")), true);
});

// Fourteen hours apart. Guessing here would be the worst error in the module.
Deno.test("CST is refused, not guessed", () => {
  assertEquals(isAmbiguous("CST"), true);
});

Deno.test("BST is refused, not guessed", () => {
  assertEquals(isAmbiguous("BST"), true);
});

// -------------------------------------------------------------- IANA names

Deno.test("IANA names resolve and are DST-aware", () => {
  assertEquals(minutesFor("America/New_York", JAN), -300);
  assertEquals(minutesFor("America/New_York", JUL), -240);
  assertEquals(minutesFor("Asia/Kolkata", JAN), 330);
});

Deno.test("IANA names are case-insensitive and accept a space for the underscore", () => {
  assertEquals(minutesFor("america/new_york", JAN), -300);
  assertEquals(minutesFor("America/New York", JAN), -300);
});

Deno.test("a slash that is not a zone resolves to nothing", () => {
  assertEquals(resolveZone("Foo/Bar"), null);
});

// ------------------------------------------------------------------ cities

Deno.test("city names come from the zone list itself", () => {
  assertEquals(minutesFor("tokyo", JAN), 540);
  assertEquals(minutesFor("kolkata", JAN), 330);
  assertEquals(minutesFor("new york", JAN), -300);
  assertEquals(minutesFor("new york", JUL), -240);
});

// --------------------------------------------------------------- countries

Deno.test("single-zone countries resolve", () => {
  assertEquals(minutesFor("india", JAN), 330);
  assertEquals(minutesFor("japan", JAN), 540);
  assertEquals(minutesFor("ireland", JAN), 0);
});

Deno.test("common informal country names resolve", () => {
  assertEquals(minutesFor("uk", JAN), 0);
  assertEquals(minutesFor("england", JAN), 0);
});

// The rule that stops the ambiguity check being pedantic: Germany's two zones
// have agreed for decades, so there is nothing to ask about.
Deno.test("a country whose zones agree is not ambiguous", () => {
  assertEquals(minutesFor("germany", JAN), 60);
  assertEquals(minutesFor("germany", JUL), 120);
});

// And the rule doing its job: the US spans five offsets.
Deno.test("a country whose zones disagree is refused", () => {
  assertEquals(isAmbiguous("united states"), true);
  assertEquals(isAmbiguous("australia"), true);
});

Deno.test("the refusal names concrete zones to pick from", () => {
  const c = resolveZone("united states") as ZoneCandidate;
  const r = offsetForCandidate(c, JAN);
  if (!("disagree" in r)) throw new Error("expected disagreement");
  assertEquals(r.disagree.length > 1, true);
  // Sorted west to east, each a real IANA id the author can paste back.
  assertEquals(r.disagree[0].minutes < r.disagree[1].minutes, true);
  assertEquals(r.disagree.every((d) => d.zone.includes("/")), true);
});

// ------------------------------------------------------------- non-zones

// The check that stops "july 10" losing its day to the zone splitter.
Deno.test("a bare number is never a timezone", () => {
  assertEquals(resolveZone("10"), null);
  assertEquals(resolveZone("2026"), null);
});

Deno.test("ordinary words are not timezones", () => {
  assertEquals(resolveZone("dinner"), null);
  assertEquals(resolveZone("tomorrow"), null);
  assertEquals(resolveZone(""), null);
});

// --------------------------------------------------------------- plumbing

Deno.test("offsetMinutesAt tracks DST", () => {
  assertEquals(offsetMinutesAt(JAN, "America/New_York"), -300);
  assertEquals(offsetMinutesAt(JUL, "America/New_York"), -240);
  // A zone with no DST and a half-hour offset, which catches sign and
  // remainder mistakes that whole-hour zones hide.
  assertEquals(offsetMinutesAt(JAN, "Asia/Kolkata"), 330);
  assertEquals(offsetMinutesAt(JUL, "Asia/Kolkata"), 330);
});

Deno.test("formatOffset renders both signs and half hours", () => {
  assertEquals(formatOffset(330), "UTC+05:30");
  assertEquals(formatOffset(-300), "UTC-05:00");
  assertEquals(formatOffset(0), "UTC+00:00");
  assertEquals(formatOffset(-210), "UTC-03:30");
});
