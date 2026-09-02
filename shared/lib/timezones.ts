// shared/lib/timezones.ts
//
// Turns whatever someone types for a timezone into a UTC offset.
//
// Five spellings, because people do not agree on one:
//
//   offset       UTC+5, GMT-8, UTC+05:30, +0530, Z
//   IANA name    America/New_York, Asia/Kolkata
//   abbreviation EST, PST, CET, JST, AEST
//   city         new york, tokyo, kolkata
//   country      india, japan, germany
//
// NOTHING IS GUESSED
// ------------------
// The rule this module exists to enforce: when a spelling could mean more
// than one offset, it is refused with the options rather than resolved to a
// favourite. "IST" is India (+5:30), Ireland (+1) and Israel (+2/+3), and a
// poll told to close at 3pm IST that closes four and a half hours early is a
// worse outcome than one that asks which IST you meant. Same reasoning as
// the importer's refusal to fuzzy-match a question: a confident wrong answer
// costs more than an honest question.
//
// AMBIGUITY IS MEASURED IN OFFSETS, NOT NAMES
// -------------------------------------------
// Germany resolves to two IANA zones, Europe/Berlin and Europe/Busingen, and
// they have had the same offset for decades — asking someone to choose
// between them would be pedantry. The United States resolves to 29 zones
// across five offsets, and asking is the only correct thing to do. So a
// phrase is ambiguous when its candidate zones DISAGREE at the instant in
// question, never merely when there are several of them.
//
// NO DATA FILE
// ------------
// Cities come from Intl.supportedValuesOf('timeZone') (418 zones) and
// countries from Intl.DisplayNames inverted over the ISO 3166 alpha-2 space,
// both built lazily and cached. Only the abbreviation table is hand-written,
// because Intl exposes letter abbreviations for North American zones and
// renders every other zone's short name as "GMT+5:30".

/** Minutes east of UTC that `timeZone` is at the instant `utc`. DST-aware. */
export function offsetMinutesAt(utc: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utc);

  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);

  // hour comes back as 24 at midnight under hour12:false in some ICU builds.
  const asIfUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute, f.second);
  return (asIfUtc - utc.getTime()) / 60_000;
}

export type ZoneCandidate =
  /** A spelling that names an offset outright. Never ambiguous. */
  | { kind: "fixed"; minutes: number; label: string }
  /** A spelling that names places. May or may not agree; the caller checks. */
  | { kind: "zones"; zones: string[]; label: string };

/**
 * Abbreviations that name exactly one offset.
 *
 * An abbreviation is a claim about an offset, not about a place — "EST" is
 * UTC-5 whether it is written in Toronto or Cancun — so these resolve to
 * fixed minutes rather than to zones. Daylight variants are listed separately
 * (EST/EDT) because that is how people write them.
 */
const ABBREVIATION_OFFSETS: Record<string, number> = {
  utc: 0, gmt: 0, z: 0, ut: 0,
  // North America
  est: -300, edt: -240,
  mst: -420, mdt: -360,
  pst: -480, pdt: -420,
  akst: -540, akdt: -480,
  hst: -600, hdt: -540,
  nst: -210, ndt: -150,
  // Europe / Africa
  wet: 0, west: 60,
  cet: 60, cest: 120,
  eet: 120, eest: 180,
  msk: 180,
  sast: 120, eat: 180, wat: 60, cat: 120,
  // Asia
  jst: 540, kst: 540,
  sgt: 480, hkt: 480, pht: 480, wib: 420, ict: 420,
  gst: 240, pkt: 300, npt: 345, bst_bd: 360,
  // Oceania
  aest: 600, aedt: 660,
  acst: 570, acdt: 630,
  awst: 480,
  nzst: 720, nzdt: 780,
  // South America
  art: -180, brt: -180, clt: -240, pet: -300, vet: -240,
};

/**
 * Abbreviations that name more than one offset, and the options to offer.
 *
 * Each of these is in real use for every meaning listed, which is why none of
 * them can be quietly resolved to whichever is most common in the author's
 * part of the world. CST is the sharpest: US Central and China Standard are
 * fourteen hours apart.
 */
const AMBIGUOUS_ABBREVIATIONS: Record<string, string[]> = {
  ist: ["India, `UTC+5:30`", "Ireland, `UTC+1`", "Israel, `UTC+3`"],
  cst: ["US Central, `UTC-6`", "China, `UTC+8`", "Cuba, `UTC-5`"],
  cdt: ["US Central Daylight, `UTC-5`", "Cuba Daylight, `UTC-4`"],
  bst: ["British Summer Time, `UTC+1`", "Bangladesh, `UTC+6`"],
  amt: ["Amazon, `UTC-4`", "Armenia, `UTC+4`"],
  wst: ["Western Sahara, `UTC+1`", "Samoa, `UTC+13`"],
  act: ["Acre, `UTC-5`", "ASEAN Common Time, `UTC+8`"],
  est_au: ["Eastern Australia, `UTC+10`", "US Eastern, `UTC-5`"],
};

let cityIndex: Map<string, string[]> | null = null;
let countryIndex: Map<string, string> | null = null;

/**
 * City name -> IANA zones, derived from the zone list itself.
 *
 * The last path segment of an IANA id is a city ("America/Indiana/Vevay" ->
 * "vevay"), so this is free and stays current with the runtime's tzdata
 * rather than with a table someone has to remember to update.
 */
function cities(): Map<string, string[]> {
  if (cityIndex) return cityIndex;
  const index = new Map<string, string[]>();
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    const city = zone.split("/").pop()!.replace(/_/g, " ").toLowerCase();
    const existing = index.get(city);
    if (existing) existing.push(zone);
    else index.set(city, [zone]);
  }
  cityIndex = index;
  return index;
}

/**
 * Country name -> ISO 3166 alpha-2, by inverting Intl.DisplayNames over the
 * 676 possible two-letter codes and keeping the ones it recognises (~280).
 * Costs single-digit milliseconds, once.
 */
function countries(): Map<string, string> {
  if (countryIndex) return countryIndex;
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const index = new Map<string, string>();
  for (let a = 65; a < 91; a++) {
    for (let b = 65; b < 91; b++) {
      const code = String.fromCharCode(a, b);
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        continue;
      }
      // An unrecognised code comes back as itself.
      if (!name || name === code) continue;
      index.set(name.toLowerCase(), code);
    }
  }
  // Spellings people use that are not the CLDR display name.
  const aliases: Record<string, string> = {
    "usa": "US", "us": "US", "america": "US", "united states of america": "US",
    "uk": "GB", "britain": "GB", "great britain": "GB", "england": "GB",
    "uae": "AE", "south korea": "KR", "north korea": "KP",
    "russia": "RU", "vietnam": "VN", "czechia": "CZ", "holland": "NL",
  };
  for (const [name, code] of Object.entries(aliases)) index.set(name, code);

  countryIndex = index;
  return index;
}

function zonesForCountry(code: string): string[] {
  try {
    // getTimeZones is on Intl.Locale; `und-XX` names the region with no
    // language attached, which is what we actually mean.
    const locale = new Intl.Locale(`und-${code}`) as Intl.Locale & {
      getTimeZones?: () => string[] | undefined;
    };
    return locale.getTimeZones?.() ?? [];
  } catch {
    return [];
  }
}

function isValidIana(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** `UTC+5`, `GMT-08:00`, `+0530`, `utc+5:30`. Null if it is not one. */
function parseFixedOffset(phrase: string): ZoneCandidate | null {
  const m = /^(?:utc|gmt|ut)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(phrase);
  if (!m) return null;

  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  // Real offsets run UTC-12 to UTC+14.
  if (hours > 14 || minutes > 59) return null;
  const total = sign * (hours * 60 + minutes);
  if (total < -720 || total > 840) return null;

  const hh = String(Math.floor(Math.abs(total) / 60)).padStart(2, "0");
  const mm = String(Math.abs(total) % 60).padStart(2, "0");
  return { kind: "fixed", minutes: total, label: `UTC${total < 0 ? "-" : "+"}${hh}:${mm}` };
}

export interface ZoneAmbiguity {
  /** The phrase as typed. */
  phrase: string;
  /** Human-readable options, already formatted for a message. */
  options: string[];
}

/**
 * Resolves a typed timezone phrase.
 *
 * Returns null when the phrase names no timezone at all, which is how the
 * caller tells "july 10 dinner" (not a zone) from "july 10 IST" (a zone it
 * must ask about).
 */
export function resolveZone(phrase: string): ZoneCandidate | ZoneAmbiguity | null {
  const p = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!p) return null;
  // A bare number is a date fragment, never a zone. Without this, "july 10"
  // would try to read "10" as one.
  if (/^\d+$/.test(p)) return null;

  const fixed = parseFixedOffset(p.replace(/\s+/g, ""));
  if (fixed) return fixed;

  const bare = p.replace(/\s+/g, "");
  if (AMBIGUOUS_ABBREVIATIONS[bare]) {
    return { phrase, options: AMBIGUOUS_ABBREVIATIONS[bare] };
  }
  if (bare in ABBREVIATION_OFFSETS) {
    return {
      kind: "fixed",
      minutes: ABBREVIATION_OFFSETS[bare],
      label: bare.toUpperCase().replace(/_.*$/, ""),
    };
  }

  // IANA ids are written with underscores and a slash; accept a space for the
  // underscore since that is how people type them.
  if (p.includes("/")) {
    const candidate = p.replace(/ /g, "_");
    // Intl accepts these case-insensitively, but echo the canonical spelling.
    const canonical = Intl.supportedValuesOf("timeZone").find(
      (z) => z.toLowerCase() === candidate,
    );
    if (canonical) return { kind: "zones", zones: [canonical], label: canonical };
    if (isValidIana(candidate)) return { kind: "zones", zones: [candidate], label: candidate };
    return null;
  }

  const city = cities().get(p);
  if (city) {
    return { kind: "zones", zones: city, label: titleCase(p) };
  }

  const code = countries().get(p);
  if (code) {
    const zones = zonesForCountry(code);
    if (zones.length > 0) return { kind: "zones", zones, label: titleCase(p) };
  }

  // Renamed cities. Intl lists the canonical id, which is often the old name
  // — Asia/Calcutta, not Asia/Kolkata; Asia/Saigon, not Asia/Ho_Chi_Minh — so
  // the index built from that list misses what people actually type. Intl
  // itself resolves the modern alias, so pairing the word with each IANA area
  // finds it without a table of renames that would need maintaining as cities
  // are renamed again.
  const areas = [
    "Asia", "America", "Europe", "Africa", "Australia",
    "Pacific", "Atlantic", "Indian", "Antarctica", "Arctic",
  ];
  const underscored = p.replace(/ /g, "_");
  for (const area of areas) {
    const candidate = `${area}/${titleCase(underscored.replace(/_/g, " ")).replace(/ /g, "_")}`;
    if (isValidIana(candidate)) {
      return { kind: "zones", zones: [candidate], label: candidate };
    }
  }

  return null;
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The offset a candidate implies at a given instant, or the disagreement.
 *
 * `at` matters: a zone's offset depends on the date, so resolving "new york"
 * for a poll closing in January and one closing in July gives -5 and -4.
 */
export function offsetForCandidate(
  candidate: ZoneCandidate,
  at: Date,
): { minutes: number; label: string } | { disagree: { minutes: number; zone: string }[] } {
  if (candidate.kind === "fixed") {
    return { minutes: candidate.minutes, label: candidate.label };
  }

  const seen = new Map<number, string>();
  for (const zone of candidate.zones) {
    const minutes = offsetMinutesAt(at, zone);
    if (!seen.has(minutes)) seen.set(minutes, zone);
  }

  // The rule this module exists for: several zones that agree are one answer.
  if (seen.size === 1) {
    const [minutes] = [...seen.keys()];
    return { minutes, label: candidate.label };
  }

  return {
    disagree: [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([minutes, zone]) => ({ minutes, zone })),
  };
}

/** "UTC+05:30", for messages. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${
    String(abs % 60).padStart(2, "0")
  }`;
}
