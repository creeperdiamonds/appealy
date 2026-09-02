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

export interface ParsedWhen {
  ok: true;
  /** The resolved instant, always in the future relative to `now`. */
  at: Date;
  /** How it was expressed. Callers explain hour-rounding differently for each. */
  kind: "relative" | "absolute";
}

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

function parseAbsolute(input: string, now: Date): WhenResult | null {
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

  const build = (y: number) =>
    new Date(Date.UTC(y, month, day, Math.floor(minutesIntoDay / 60), minutesIntoDay % 60, 0));

  // No year given means the next time this date happens — "july 10" typed in
  // December is next July, not one that has already gone.
  let at = build(year ?? now.getUTCFullYear());
  if (year === null && at.getTime() <= now.getTime()) {
    at = build(now.getUTCFullYear() + 1);
  }

  // Rolls over on a bad day-of-month (31 September becomes 1 October), which
  // is a silent misreading rather than an error.
  if (at.getUTCDate() !== day || at.getUTCMonth() !== month) {
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

  const relative = parseRelative(normalized, now);
  if (relative) return relative;

  const absolute = parseAbsolute(normalized, now);
  if (absolute) return absolute;

  return fail(
    "I couldn't read that as a time. Try a duration like `1h 20m` or `10 hours 50 minutes`, " +
      "or a date like `july 10` or `2026-07-10 14:30`.",
  );
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
