// shared/services/automodRegex.ts
//
// Builds AutoMod regex patterns from plain choices, and runs patterns in the
// browser, for the pattern builder on the dashboard's AutoMod page. Most people
// setting up a server don't write regex, and the ones who do can't easily test
// it: Discord only checks a pattern when the rule is saved.
//
// What Discord runs, from its help article (support.discord.com, "Filter
// Messages Using Regular Expressions"): Rust's regex engine, with
// case-insensitive and Unicode matching already on for every pattern, no
// backreferences, and a compile-size limit it doesn't publish. Patterns can be
// 260 characters. The article still says 75, but that's from before December
// 2022, when Discord's API changelog raised it.
//
// So everything built here uses only syntax that means the same in Rust and in
// JavaScript: character classes, \uXXXX, \p{...}, groups, alternation, counted
// repeats and anchors. That's what lets the page show what a pattern catches
// before Discord ever sees it. Gaps between letters use [^a-z0-9] rather than
// \W or \p{L}: repeated through a pattern, the big Unicode tables are what run
// into that size limit, and a negated ASCII class stays small.
//
// Lives in shared/ so CI's Deno test run covers it; the web app imports it.

import { LIMITS } from "./automodRules.ts";

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Characters that mean something outside a class, in Rust and JavaScript alike. */
const META = new Set([..."\\.+*?()|[]{}^$"]);

/**
 * And inside one. Rust also gives `[` a meaning there (nested classes), and
 * escaping it is valid in both.
 */
const CLASS_META = new Set([..."\\[]^-"]);

/** Text that should match itself, and nothing else. */
export function escapeText(text: string): string {
  return [...text].map((c) => (META.has(c) ? `\\${c}` : c)).join("");
}

function charClass(chars: readonly string[]): string {
  const unique = [...new Set(chars)];
  if (unique.length === 1) return escapeText(unique[0]);
  return `[${unique.map((c) => (CLASS_META.has(c) ? `\\${c}` : c)).join("")}]`;
}

// ---------------------------------------------------------------------------
// Packing into Discord's limits
// ---------------------------------------------------------------------------

export interface Built {
  patterns: string[];
  /** What went into each pattern, in the same order: the words or sites it covers. */
  groups: string[][];
  /** Inputs that don't fit in 260 characters even in a pattern of their own. */
  tooLong: string[];
}

/**
 * Fits the pieces into as few patterns as Discord's length limit allows,
 * because a rule only holds ten of them. Order is kept.
 */
function pack(items: { label: string; body: string }[], wrap: (bodies: string[]) => string): Built {
  const patterns: string[] = [];
  const groups: string[][] = [];
  const tooLong: string[] = [];
  let bodies: string[] = [];
  let labels: string[] = [];
  const flush = () => {
    if (bodies.length === 0) return;
    patterns.push(wrap(bodies));
    groups.push(labels);
  };
  for (const { label, body } of items) {
    if (wrap([body]).length > LIMITS.regexLength) {
      tooLong.push(label);
      continue;
    }
    if (bodies.length > 0 && wrap([...bodies, body]).length <= LIMITS.regexLength) {
      bodies.push(body);
      labels.push(label);
      continue;
    }
    flush();
    bodies = [body];
    labels = [label];
  }
  flush();
  return { patterns, groups, tooLong };
}

/** Trimmed, blanks dropped, repeats removed without case. */
function cleanList(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const item = raw.trim().replace(/\s+/g, " ");
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Disguised words: "fr33 n1tr0", "$cam", "s.c.a.m", "sccaaam", Cyrillic "ѕсаm"
// ---------------------------------------------------------------------------

export interface DisguiseOptions {
  /** Digits and symbols for letters: 4 for a, $ for s, 0 for o. */
  numbers: boolean;
  /** Cyrillic and Greek letters that look Latin: "а" for "a". */
  lookalikes: boolean;
  /** Accented letters: é for e, ñ for n. */
  accents: boolean;
  /** Letters held down: "sccaaam". */
  repeats: boolean;
  /** Spaces or symbols between letters: "s c a m", "s.c.a.m", "s_c_a_m". */
  gaps: boolean;
  /** Only as a word of its own: "scam" but not "scampi". */
  wholeWord: boolean;
}

export const DEFAULT_DISGUISE: DisguiseOptions = {
  numbers: true,
  lookalikes: true,
  accents: false,
  repeats: true,
  gaps: true,
  wholeWord: true,
};

const NUMBERS: Record<string, string> = {
  a: "4@",
  b: "8",
  c: "(",
  e: "3",
  g: "9",
  i: "1!|",
  l: "1|",
  o: "0",
  s: "5$",
  t: "7+",
  z: "2",
};

// From Unicode's confusables: letters that render like the Latin one in most
// fonts. Lowercase only, because Discord matches without case, and that
// covers the capitals too.
const LOOKALIKES: Record<string, string> = {
  a: "аɑα",
  c: "сϲ",
  d: "ԁ",
  e: "е",
  g: "ɡ",
  h: "һ",
  i: "іı",
  j: "ј",
  k: "κ",
  l: "ӏ",
  o: "оο",
  p: "рρ",
  q: "ԛ",
  s: "ѕ",
  u: "υ",
  v: "ν",
  w: "ԝ",
  x: "хχ",
  y: "уγ",
};

const ACCENTS: Record<string, string> = {
  a: "àáâãäåā",
  c: "çć",
  e: "èéêëē",
  i: "ìíîïī",
  n: "ñń",
  o: "òóôõöøō",
  u: "ùúûüū",
  y: "ýÿ",
  s: "śš",
  z: "źżž",
};

/** Anything that isn't a Latin letter or a digit: what sits between the letters of "s.c.a.m". */
const GAP = "[^a-z0-9]*";
const WORD_START = "(?:^|[^a-z0-9])";
const WORD_END = "(?:[^a-z0-9]|$)";

const isAsciiAlnum = (c: string) => /^[a-z0-9]$/.test(c);
const isLetterOrDigit = (c: string) => /^[\p{L}\p{N}]$/u.test(c);

/**
 * One word or phrase as a pattern body, without the whole-word edges.
 *
 * Gaps go only between Latin letters and digits. Between the characters of a
 * word in a script without spaces, "anything can go here" would reach across
 * whole sentences.
 */
export function disguisedWord(word: string, o: DisguiseOptions): string {
  const chars = [...word.trim().replace(/\s+/g, " ").toLowerCase()];
  let out = "";
  let previous = "";
  for (const ch of chars) {
    if (ch === " ") {
      out += o.gaps ? GAP : "\\s*";
      previous = "";
      continue;
    }
    if (o.gaps && isAsciiAlnum(previous) && isAsciiAlnum(ch)) out += GAP;
    if (/^[a-z]$/.test(ch)) {
      const variants = [
        ch,
        ...(o.numbers ? NUMBERS[ch] ?? "" : ""),
        ...(o.lookalikes ? LOOKALIKES[ch] ?? "" : ""),
        ...(o.accents ? ACCENTS[ch] ?? "" : ""),
      ];
      out += charClass(variants);
    } else {
      out += escapeText(ch);
    }
    if (o.repeats && isLetterOrDigit(ch)) out += "+";
    previous = ch;
  }
  return out;
}

/** Words and phrases, packed into as few patterns as fit. */
export function wordPatterns(words: readonly string[], o: DisguiseOptions): Built {
  const items = cleanList(words).map((w) => ({ label: w, body: disguisedWord(w, o) }));
  return pack(items, (bodies) => {
    if (!o.wholeWord) return bodies.join("|");
    const inner = bodies.length > 1 ? `(?:${bodies.join("|")})` : bodies[0];
    return `${WORD_START}${inner}${WORD_END}`;
  });
}

/**
 * Ways to write a word that the pattern built with these options catches, for
 * the builder to show and the tests to check. Look-alike letters are left out:
 * an example that looks identical to the word explains nothing.
 */
export function disguiseExamples(word: string, o: DisguiseOptions): string[] {
  const base = word.trim().replace(/\s+/g, " ").toLowerCase();
  if (!/[a-z]/.test(base)) return [];
  const out: string[] = [];
  if (o.numbers) {
    // Digits and $ or @ read as the letter; ( for c or | for l would only confuse.
    const swapped = [...base].map((c) => NUMBERS[c]?.match(/[0-9$@]/)?.[0] ?? c).join("");
    if (swapped !== base) out.push(swapped);
  }
  if (o.gaps) {
    const spaced = base
      .split(" ")
      .map((w) => [...w].join("."))
      .join(" ");
    if (spaced !== base) out.push(spaced);
  }
  const chars = [...base];
  const vowel = chars.findIndex((c) => /[aeiou]/.test(c));
  if (o.repeats) {
    const i = vowel >= 0 ? vowel : chars.findIndex((c) => /[a-z]/.test(c));
    out.push(chars.map((c, j) => (j === i ? c.repeat(3) : c)).join(""));
  }
  if (o.accents && vowel >= 0) {
    out.push(chars.map((c, j) => (j === vowel ? ACCENTS[c][1] : c)).join(""));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const DOT = "\\s*(?:\\.|\\(\\.\\)|\\[\\.\\]|dot)\\s*";
const SLASH = "\\s*(?:/|slash)\\s*";

export interface Preset {
  id: string;
  label: string;
  /** What it catches, as someone would type it. */
  example: string;
  pattern: string;
  /** Said before adding it, when it can catch things that aren't the target. */
  caution?: string;
}

/** Server invites, including ones written "discord dot gg slash abc" to get past filters. */
export const INVITE_LINKS: Preset = {
  id: "invites",
  label: "Discord server invites",
  example: "discord.gg/abc, discord dot gg slash abc",
  pattern: `(?:discord(?:app)?${DOT}com${SLASH}invite|discord${DOT}(?:gg|io|me|li)|dsc${DOT}gg)${SLASH}[a-z0-9-]+`,
};

export const ANY_LINK: Preset = {
  id: "links",
  label: "Any link",
  example: "https://example.com, www.example.com",
  pattern: "(?:https?://|www\\.)\\S+",
};

/** Sites that log the IP address of anyone who opens the link. */
export const IP_GRABBER_SITES = ["grabify.link", "iplogger.org", "iplogger.com", "iplogger.ru", "2no.co", "yip.su"];

/** A site, typed as a person would: with or without https://, www. or a path. */
export function cleanDomain(raw: string): string | null {
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.+$/, "");
  return /^[^\s.]+(\.[^\s.]+)+$/.test(domain) ? domain : null;
}

/**
 * Links to these sites and any of their subdomains, with or without
 * https://. "notgrabify.link" is a different site and isn't caught.
 */
export function sitePatterns(domains: readonly string[]): Built {
  const cleaned = [...new Set(domains.map(cleanDomain).filter((d): d is string => d !== null))];
  const items = cleaned.map((d) => ({ label: d, body: escapeText(d) }));
  return pack(items, (bodies) => `(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\\.)*(?:${bodies.join("|")})(?:[^a-z0-9-]|$)`);
}

// ---------------------------------------------------------------------------
// Personal information
// ---------------------------------------------------------------------------

export const EMAILS: Preset = {
  id: "emails",
  label: "Email addresses",
  example: "name@example.com",
  pattern: "[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}",
};

export const SPELLED_EMAILS: Preset = {
  id: "spelled-emails",
  label: "Spelled-out email addresses",
  example: "name at gmail dot com, name[at]gmail[dot]com",
  pattern:
    "[a-z0-9._%+-]+\\s*[(\\[]?\\s*at\\s*[)\\]]?\\s*[a-z0-9-]+\\s*[(\\[]?\\s*dot\\s*[)\\]]?\\s*[a-z]{2,}",
  caution: "Can catch ordinary sentences like “look at this dot com”. Try some messages first.",
};

/**
 * Numbers grouped the ways phone numbers are written: 555-123-4567 and
 * 07700 900123, pairs like 06 12 34 56 78, and 98765 43210, each with an
 * optional +country code. A digit run on either side stops the match, which
 * keeps Discord IDs (17 to 20 digits in one run) and dates like 2026-09-26 out.
 */
export const PHONE_NUMBERS: Preset = {
  id: "phones",
  label: "Phone numbers",
  example: "+1 (555) 123-4567, 07700 900123",
  pattern:
    "(?:^|[^\\d])(?:\\+\\d{1,3}[\\s.-]?)?(?:\\(?\\d{2,5}\\)?[\\s.-]?\\d{3,4}[\\s.-]?\\d{3,6}" +
    "|\\d{2}(?:[\\s.-]\\d{2}){4}|\\d{5}[\\s.-]\\d{5})(?:[^\\d]|$)",
  caution: "Also catches other long numbers, like order numbers.",
};

export const IP_ADDRESSES: Preset = {
  id: "ips",
  label: "IP addresses",
  example: "192.168.0.1",
  // A full stop may end the sentence after it, just not start a fifth number.
  pattern: "(?:^|[^\\d.])(?:\\d{1,3}\\.){3}\\d{1,3}(?:[^\\d.]|\\.(?:[^\\d]|$)|$)",
};

// ---------------------------------------------------------------------------
// Spam tricks
// ---------------------------------------------------------------------------

/**
 * Letters buried under stacks of accent marks. Three combining marks in a row
 * is past anything a language needs.
 */
export const ZALGO: Preset = {
  id: "zalgo",
  label: "Zalgo text",
  example: "Z̷̢̛a̶̡l̵̨g̸̛o̴̢",
  pattern: "[\\u0300-\\u036F\\u1AB0-\\u1AFF\\u1DC0-\\u1DFF\\u20D0-\\u20FF\\uFE20-\\uFE2F]{3,}",
};

/**
 * Characters that show as nothing: slipped inside a blocked word so the filter
 * misses it, or used for blank messages and blank names. The zero-width joiner
 * is left out on purpose: emoji like 👨‍👩‍👧 are built with it.
 */
export const INVISIBLE: Preset = {
  id: "invisible",
  label: "Invisible characters",
  example: "a word split by hidden characters, or a blank message",
  pattern: "[\\u200B\\u2060-\\u2064\\uFEFF\\u180E\\u115F\\u1160\\u3164\\uFFA0\\u2800]",
};

/** Emoji, flags and custom emoji, with only spaces between them. */
export function emojiWall(count: number): string {
  const one = "(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}|<a?:[a-z0-9_]+:\\d+>)";
  return `(?:${one}[\\s\\uFE0F\\u200D\\p{Emoji_Modifier}]*){${count},}`;
}

/**
 * The same letter over and over. Rust's regex has no backreferences, so
 * "any letter, repeated" can't be written directly: it's every letter, each
 * with its own count.
 */
export function letterSpam(count: number): string {
  return [..."abcdefghijklmnopqrstuvwxyz"].map((c) => `${c}{${count},}`).join("|");
}

/**
 * At least this many capitals and no lowercase letters at all. Discord turns
 * case-insensitive matching on for every pattern, so this is the one pattern
 * that switches it back off.
 */
export function shouting(count: number): string {
  return `(?-i)^(?:[^a-zA-Z]*[A-Z]){${count},}[^a-z]*$`;
}

/** Line breaks in a row, with nothing but spaces between them. */
export function blankLines(count: number): string {
  return `(?:\\n[^\\S\\n]*){${count},}`;
}

// ---------------------------------------------------------------------------
// Trying patterns in the browser
// ---------------------------------------------------------------------------

export type BrowserRegex = { ok: true; regex: RegExp } | { ok: false; reason: string };

/** Punctuation JavaScript accepts escaped in Unicode mode. Rust accepts more. */
const JS_ESCAPABLE = new Set([..."^$\\.*+?()[]{}|/"]);

function propertyName(name: string): string {
  const titled = name.replace(/(^|_)([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
  for (const candidate of [name, titled, `Script=${name}`, `Script=${titled}`]) {
    try {
      new RegExp(`\\p{${candidate}}`, "u");
      return candidate;
    } catch {
      // Next spelling.
    }
  }
  return name;
}

/**
 * A pattern as a JavaScript RegExp that behaves like Discord's, or why it
 * can't be.
 *
 * Covers what differs in what people actually write: Discord's default
 * flags, flags switched at the start, \x{...} and \U escapes, \pL and script
 * names, \A and \z, (?P<name>...), and punctuation escapes Rust allows and
 * JavaScript doesn't. What it can't express (set operations inside classes,
 * flags switched halfway through) is reported rather than guessed at: those
 * patterns still work in Discord, they just can't be tried here.
 *
 * Close rather than exact. JavaScript's \w, \d and \b only know ASCII, where
 * Rust's know every script.
 */
export function toBrowserRegex(pattern: string): BrowserRegex {
  let source = pattern;
  let insensitive = true; // Discord's default
  let dotAll = false;
  let multiline = false;

  for (;;) {
    const m = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?\)/.exec(source);
    if (!m || (!m[1] && !m[2])) break;
    for (const [flags, on] of [[m[1] ?? "", true], [m[2] ?? "", false]] as const) {
      for (const f of flags) {
        if (f === "i") insensitive = on;
        else if (f === "s") dotAll = on;
        else if (f === "m") multiline = on;
        else if (f !== "u" || !on) return { ok: false, reason: `the ${f} flag` };
      }
    }
    source = source.slice(m[0].length);
  }

  let out = "";
  let inClass = false;
  let classOps = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "\\") {
      if (next === undefined) return { ok: false, reason: "a pattern ending in \\" };
      if (next === "x" && source[i + 2] === "{") {
        const end = source.indexOf("}", i);
        if (end < 0) return { ok: false, reason: "an unfinished \\x{...}" };
        out += `\\u{${source.slice(i + 3, end)}}`;
        i = end;
      } else if (next === "U" && /^[0-9a-fA-F]{8}$/.test(source.slice(i + 2, i + 10))) {
        out += `\\u{${source.slice(i + 2, i + 10)}}`;
        i += 9;
      } else if (next === "p" || next === "P") {
        if (source[i + 2] === "{") {
          const end = source.indexOf("}", i);
          if (end < 0) return { ok: false, reason: "an unfinished \\p{...}" };
          out += `\\${next}{${propertyName(source.slice(i + 3, end))}}`;
          i = end;
        } else {
          out += `\\${next}{${source[i + 2] ?? ""}}`;
          i += 2;
        }
      } else if (!inClass && next === "A") {
        out += "^";
        i++;
      } else if (!inClass && next === "z") {
        out += "$";
        i++;
      } else if (/[^\p{L}\p{N}]/u.test(next) && !JS_ESCAPABLE.has(next) && !(inClass && next === "-")) {
        // An escape Rust allows and JavaScript doesn't, like \# or \&: the
        // character on its own means the same thing.
        out += next;
        i++;
      } else {
        out += c + next;
        i++;
      }
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      else if ((c === "&" || c === "-" || c === "~") && next === c) classOps = true;
      else if (c === "[") classOps = true; // a nested class
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      // Rust reads a ] straight after [ or [^ as a literal; JavaScript as the end.
      const negated = next === "^";
      if (negated) {
        out += "^";
        i++;
      }
      if (source[i + 1] === "]") {
        out += "\\]";
        i++;
      }
      continue;
    }
    if (c === "(" && source.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
      continue;
    }
    out += c;
  }

  const flags = `g${insensitive ? "i" : ""}${dotAll ? "s" : ""}${multiline ? "m" : ""}`;
  try {
    return { ok: true, regex: new RegExp(out, `${flags}${classOps ? "v" : "u"}`) };
  } catch {
    return {
      ok: false,
      reason: classOps ? "set operations inside a character class" : "syntax this browser can't run",
    };
  }
}

export interface Match {
  index: number;
  text: string;
}

/** Up to `limit` matches of a pattern in a message. */
export function findMatches(regex: RegExp, text: string, limit = 20): Match[] {
  const out: Match[] = [];
  regex.lastIndex = 0;
  for (const m of text.matchAll(regex)) {
    out.push({ index: m.index ?? 0, text: m[0] });
    if (out.length >= limit) break;
  }
  return out;
}
