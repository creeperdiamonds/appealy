// shared/lib/when.ts
//
// Parses the free text someone types when the bot asks "when should this
// close?" — "1h 20m", "10 hours 50 minutes", "2d", "july 10".
//
// Two grammars, tried in that order:
//
//   relative  a run of <number><unit> pairs, summed. "1h 20m", "2 days",
//             "1 day 3 hours 30 minutes".
//   absolute  a calendar date, optionally with a time. "july 10",
//             "10 july", "2026-07-10", "july 10 14:30", "july 10 2pm".
//
// EVERYTHING IS UTC, and that is a limitation rather than a decision. Nothing
// in the schema stores a guild's timezone, so there is no correct local zone
// to resolve "july 10" against. Inventing one would be worse than being
// explicit: callers are expected to echo the resolved instant back as a
// Discord <t:...:F> timestamp, which every reader sees in their OWN zone, so
// the author can see what was understood and correct it before committing.
//
// Pure, and takes `now` as a parameter, because "july 10" means a different
// instant depending on when it is read and a test that depends on the wall
// clock is a test that fails in December.
//
// A trailing timezone is recognised where one is typed — "july 10 3pm EST",
// "14:00 UTC+5:30", "july 10 tokyo", "july 10 3pm india" — and resolved by
// shared/lib/timezones.ts, which refuses the spellings that mean more than
// one offset rather than picking a favourite. Without a zone the fields are
// read as UTC, which is a limitation and not a decision: nothing in the
// schema stores a guild timezone.

export interface ParsedWhen {
  ok: true;
  /** The resolved instant, always in the future relative to `now`. */
  at: Date;
  /** How it was expressed. Callers explain hour-rounding differently for each. */
  kind: "relative" | "absolute";
  /**
   * The timezone that was recognised, if one was typed — "IST", "Asia/Kolkata",
   * "India". Absent when none was given, in which case the fields were read as
   * UTC. Worth echoing back: it is the difference between the author checking
   * a time and assuming it.
   */
  zone?: string;
  /** Minutes east of UTC that `zone` resolved to, for the same reason. */
  offsetMinutes?: number;
}

import {
  formatOffset,
  offsetForCandidate,
  resolveZone,
  type ZoneAmbiguity,
  type ZoneCandidate,
} from "./timezones.ts";

export interface WhenFailure {
  ok: false;
  /** Shown to the person who typed it, so it says what to do instead. */
  reason: string;
}

export type WhenResult = ParsedWhen | WhenFailure;

const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Unit spellings. `m` is minutes, never months — a poll closing "in 3m"
 * meaning three months would be a genuinely bad surprise, and months are not
 * expressible in a Discord poll anyway.
 */
const UNITS: Record<string, keyof typeof MS> = {
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s",
  m: "m", min: "m", mins: "m", minute: "m", minutes: "m",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
  w: "w", week: "w", weeks: "w",
};

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

/** A year out. Catches a typo'd year before it becomes a poll nobody can close. */
const MAX_AHEAD_MS = 366 * MS.d;

function fail(reason: string): WhenFailure {
  return { ok: false, reason };
}

/** "14:30", "2pm", "2:05 pm" -> minutes since midnight. Null if not a time. */
function parseTimeOfDay(raw: string): number | null {
  const t = raw.trim().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
  if (!m) return null;

  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];

  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (meridiem === "pm") hours += 12;
  } else if (hours > 23) {
    return null;
  }
  // A bare "10" is a duration ("10 hours"?) or an hour of the day; the caller
  // only reaches here having already failed the relative grammar, so treating
  // it as a time is the remaining reading.
  return hours * 60 + minutes;
}

function parseRelative(input: string, now: Date): WhenResult | null {
  // Strip the connectives people write between units so "1 day and 2 hours"
  // parses the same as "1d 2h".
  const cleaned = input.replace(/\band\b/g, " ").replace(/,/g, " ").trim();
  if (!cleaned) return null;

  const token = /(\d+)\s*([a-z]+)/g;
  let total = 0;
  let matched = 0;
  let consumed = 0;

  for (let m = token.exec(cleaned); m !== null; m = token.exec(cleaned)) {
    const unit = UNITS[m[2]];
    // A number followed by something that is not a duration unit means this
    // is not a duration at all — "10 july" must fall through to the calendar
    // grammar rather than being read as ten of something.
    if (!unit) return null;
    total += Number(m[1]) * MS[unit];
    matched++;
    consumed += m[0].length;
  }

  if (matched === 0) return null;
  // Everything except whitespace has to have been part of a pair, so a
  // trailing word cannot be silently ignored.
  if (consumed < cleaned.replace(/\s+/g, "").length) return null;
  if (total <= 0) return fail("That works out to no time at all. Try something like `1h 20m`.");
  if (total > MAX_AHEAD_MS) return fail("That's more than a year away. Try something shorter.");

  return { ok: true, at: new Date(now.getTime() + total), kind: "relative" };
}

/**
 * Splits a trailing timezone phrase off the input.
 *
 * Tries the last three tokens, then two, then one, and takes the longest that
 * resolves — "new york" must win over "york", and "united arab emirates" over
 * "emirates". A bare number never resolves (see resolveZone), which is what
 * stops "july 10" losing its day.
 */
function splitTrailingZone(
  input: string,
): { body: string; zone: ZoneCandidate | ZoneAmbiguity | null } {
  const tokens = input.split(" ");
  for (let take = Math.min(3, tokens.length - 1); take >= 1; take--) {
    const phrase = tokens.slice(tokens.length - take).join(" ");
    // "at" and "in" read as connectives here, not places, and Intl knows
    // neither as a country name — but guard anyway, since "in" is India's
    // ISO code and a future alias table could make that a real collision.
    if (/^(at|in|on)$/.test(phrase)) continue;
    const zone = resolveZone(phrase);
    if (zone) {
      return { body: tokens.slice(0, tokens.length - take).join(" ").trim(), zone };
    }
  }
  return { body: input, zone: null };
}

function parseAbsolute(input: string, now: Date, zoneOffsetMinutes: number | null): WhenResult | null {
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let rest = input;

  // ISO first: 2026-07-10, optionally with a time after it.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(input);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]) - 1;
    day = Number(iso[3]);
    rest = input.slice(iso[0].length);
  } else {
    // "july 10" or "10 july", each optionally followed by a time.
    const monthFirst = /^([a-z]+)\s+(\d{1,2})\b/.exec(input);
    const dayFirst = /^(\d{1,2})\s+([a-z]+)\b/.exec(input);
    if (monthFirst && MONTHS[monthFirst[1]] !== undefined) {
      month = MONTHS[monthFirst[1]];
      day = Number(monthFirst[2]);
      rest = input.slice(monthFirst[0].length);
    } else if (dayFirst && MONTHS[dayFirst[2]] !== undefined) {
      day = Number(dayFirst[1]);
      month = MONTHS[dayFirst[2]];
      rest = input.slice(dayFirst[0].length);
    } else {
      return null;
    }
  }

  if (month === null || day === null || day < 1 || day > 31) return null;

  // A time is optional; "at" is noise people type.
  const timeText = rest.replace(/^\s*at\s*/, "").trim();
  const minutesIntoDay = timeText ? parseTimeOfDay(timeText) : 0;
  if (minutesIntoDay === null) {
    return fail(`I understood the date but not the time in "${timeText}". Try \`july 10 14:30\`.`);
  }

  // The wall clock, held as if it were UTC. This is NOT the instant — it is
  // the calendar reading someone typed, which names an instant only once a
  // zone is chosen. Kept separate because the date checks below have to run
  // against what was typed: "july 10 2am UTC+5:30" is 9 July in UTC, and
  // comparing the converted instant's date to "10" would reject it.
  const wall = (y: number) =>
    new Date(Date.UTC(y, month, day, Math.floor(minutesIntoDay / 60), minutesIntoDay % 60, 0));

  // Subtracting the offset turns the wall clock into the instant. No zone
  // means the fields are read as UTC, which the header states and the caller
  // echoes back for checking.
  const toInstant = (w: Date) => new Date(w.getTime() - (zoneOffsetMinutes ?? 0) * 60_000);

  // No year given means the next time this date happens — "july 10" typed in
  // December is next July, not one that has already gone.
  let wallClock = wall(year ?? now.getUTCFullYear());
  let at = toInstant(wallClock);
  if (year === null && at.getTime() <= now.getTime()) {
    wallClock = wall(now.getUTCFullYear() + 1);
    at = toInstant(wallClock);
  }

  // Rolls over on a bad day-of-month (31 September becomes 1 October), which
  // is a silent misreading rather than an error. Checked on the wall clock,
  // for the reason above.
  if (wallClock.getUTCDate() !== day || wallClock.getUTCMonth() !== month) {
    return fail("That date doesn't exist. Check the day of the month.");
  }
  if (at.getTime() <= now.getTime()) return fail("That's in the past.");
  if (at.getTime() - now.getTime() > MAX_AHEAD_MS) {
    return fail("That's more than a year away. Try something sooner.");
  }

  return { ok: true, at, kind: "absolute" };
}

/**
 * Resolves what someone typed into an instant.
 *
 * `now` is injected rather than read from the clock so the absolute grammar's
 * year-rollover ("july 10" typed in December) is testable.
 */
export function parseWhen(input: string, now: Date): WhenResult {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return fail("Nothing to read there — try `1h 20m` or `july 10`.");
  if (normalized.length > 100) return fail("That's much longer than a time. Try `1h 20m` or `july 10`.");

  // A duration needs no timezone: "in 2 hours" is the same two hours
  // everywhere. Tried before the zone is split off so "2h" is not searched
  // for a trailing place name.
  const relativeWhole = parseRelative(normalized, now);
  if (relativeWhole) return relativeWhole;

  const { body, zone } = splitTrailingZone(normalized);

  // A duration with a zone stuck on it — "2h EST". Harmless and meant, so
  // the duration is honoured and the zone ignored rather than refused.
  if (zone) {
    const relativeBody = parseRelative(body, now);
    if (relativeBody) return relativeBody;
  }

  // Ambiguous before anything else: knowing WHICH date they meant does not
  // help if the zone could be any of three.
  if (zone && "options" in zone) {
    return fail(
      `\`${zone.phrase.toUpperCase()}\` means more than one thing — ${
        zone.options.join(", ")
      }. Say which, or give an offset like \`UTC+5:30\`, or an IANA name like \`Asia/Kolkata\`.`,
    );
  }

  let offsetMinutes: number | null = null;
  let zoneLabel: string | null = null;

  if (zone) {
    // Resolved against the *approximate* instant, since the exact one is not
    // known until the date is parsed — and the date is what needs the offset.
    // Any zone whose offset differs between the two is one whose DST boundary
    // falls in between, which the second pass below settles.
    const first = offsetForCandidate(zone, now);
    if ("disagree" in first) {
      return fail(
        `That could be ${
          first.disagree.map((d) => `${formatOffset(d.minutes)} (${d.zone})`).join(" or ")
        }. Give an offset like \`UTC+5:30\` or a specific zone like \`${first.disagree[0].zone}\`.`,
      );
    }
    offsetMinutes = first.minutes;
    zoneLabel = first.label;
  }

  const absolute = parseAbsolute(body, now, offsetMinutes);
  if (!absolute) {
    return fail(
      "I couldn't read that as a time. Try a duration like `1h 20m` or `10 hours 50 minutes`, " +
        "or a date like `july 10`, `2026-07-10 14:30` or `july 10 3pm EST`.",
    );
  }
  if (!absolute.ok) return absolute;

  // Second pass. The offset used above came from today's date; a poll closing
  // in July resolved against a January clock would be an hour out across a
  // DST boundary. Re-resolving at the instant just computed and reparsing
  // fixes that, and converges — the offset at the corrected instant is the
  // one that produced it.
  if (zone && zone.kind === "zones") {
    const better = offsetForCandidate(zone, absolute.at);
    if (!("disagree" in better) && better.minutes !== offsetMinutes) {
      const corrected = parseAbsolute(body, now, better.minutes);
      if (corrected && corrected.ok) {
        return { ...corrected, zone: zoneLabel ?? undefined, offsetMinutes: better.minutes };
      }
    }
  }

  return {
    ...absolute,
    zone: zoneLabel ?? undefined,
    offsetMinutes: offsetMinutes ?? undefined,
  };
}

/**
 * Hours a Discord native poll must be given to close no earlier than `at`.
 *
 * Discord takes whole hours, 1 to 768 (32 days), and nothing finer — so a
 * poll asked to close in 1h 20m closes in 2h. Rounding UP rather than to
 * nearest, because closing a poll before the time its author announced is the
 * worse of the two errors. Callers are expected to say so out loud.
 */
export function toNativePollHours(at: Date, now: Date): { hours: number; rounded: boolean } | null {
  const ms = at.getTime() - now.getTime();
  if (ms <= 0) return null;
  const exact = ms / MS.h;
  const hours = Math.ceil(exact);
  if (hours > 768) return null;
  return { hours: Math.max(1, hours), rounded: Math.abs(exact - hours) > 1e-9 };
}
