// shared/services/__tests__/automodRegex.test.ts
//
// Run with: deno test shared/services/__tests__/automodRegex.test.ts
//
// Every pattern the builder offers, run against messages it should catch and
// messages it shouldn't. They run through toBrowserRegex, the same translation
// the dashboard's tester uses, so these also check that every pattern built
// can be tried in the browser.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ANY_LINK,
  DEFAULT_DISGUISE,
  EMAILS,
  INVISIBLE,
  INVITE_LINKS,
  IP_ADDRESSES,
  IP_GRABBER_SITES,
  PHONE_NUMBERS,
  SPELLED_EMAILS,
  ZALGO,
  blankLines,
  cleanDomain,
  disguiseExamples,
  disguisedWord,
  emojiWall,
  escapeText,
  findMatches,
  letterSpam,
  shouting,
  sitePatterns,
  toBrowserRegex,
  wordPatterns,
  type DisguiseOptions,
} from "../automodRegex.ts";
import { LIMITS } from "../automodRules.ts";

function compile(pattern: string): RegExp {
  const r = toBrowserRegex(pattern);
  if (!r.ok) throw new Error(`can't compile ${pattern}: ${r.reason}`);
  return r.regex;
}

function catches(pattern: string, text: string): boolean {
  return findMatches(compile(pattern), text).length > 0;
}

function assertCatches(pattern: string, texts: string[]) {
  for (const t of texts) assert(catches(pattern, t), `expected ${pattern} to catch ${JSON.stringify(t)}`);
}

function assertMisses(pattern: string, texts: string[]) {
  for (const t of texts) assert(!catches(pattern, t), `expected ${pattern} to miss ${JSON.stringify(t)}`);
}

function onePattern(words: string[], o: DisguiseOptions = DEFAULT_DISGUISE): string {
  const built = wordPatterns(words, o);
  assertEquals(built.tooLong, []);
  assertEquals(built.patterns.length, 1);
  return built.patterns[0];
}

// --- Escaping ---------------------------------------------------------------

Deno.test("text is escaped so it only matches itself", () => {
  assertEquals(escapeText("c++ (beta)? $5 a|b"), "c\\+\\+ \\(beta\\)\\? \\$5 a\\|b");
  assertCatches(escapeText("c++ (beta)?"), ["I use c++ (beta)?"]);
  assertMisses(escapeText("c++"), ["cc"]);
});

// --- Disguised words --------------------------------------------------------

Deno.test("a disguised word is caught however it's dressed up", () => {
  const p = onePattern(["scam"]);
  assertCatches(p, [
    "scam",
    "SCAM",
    "this is a scam!",
    "$cam",
    "5c4m",
    "s.c.a.m",
    "s c a m",
    "s_c_a_m",
    "s-c-4-m",
    "sccaaamm",
    "ѕсаm", // Cyrillic ѕ, с, а
    "SC​AM", // a zero-width space inside the word
  ]);
});

Deno.test("whole-word patterns leave longer words alone", () => {
  const p = onePattern(["scam"]);
  assertMisses(p, ["scampi", "scammer", "escalator", "Scampton", "scam1"]);
});

Deno.test("without whole words, it's found inside other words too", () => {
  const p = onePattern(["scam"], { ...DEFAULT_DISGUISE, wholeWord: false });
  assertCatches(p, ["scampi", "a scammer"]);
});

Deno.test("each disguise can be switched off on its own", () => {
  const off = (k: keyof DisguiseOptions) => onePattern(["scam"], { ...DEFAULT_DISGUISE, [k]: false });
  assertMisses(off("numbers"), ["$c4m"]);
  assertMisses(off("lookalikes"), ["ѕсаm"]);
  assertMisses(off("repeats"), ["sccaaam"]);
  assertMisses(off("gaps"), ["s.c.a.m", "s c a m"]);
  // Accents are off by default.
  assertMisses(onePattern(["scam"]), ["scám"]);
  assertCatches(onePattern(["scam"], { ...DEFAULT_DISGUISE, accents: true }), ["scám", "SCÄM"]);
});

Deno.test("a phrase is caught with or without the space", () => {
  const p = onePattern(["free nitro"]);
  assertCatches(p, ["free nitro", "FREE NITRO here", "freenitro", "fr33 n1tr0", "f r e e  n i t r o"]);
  assertMisses(p, ["free", "nitro boost", "freedom nitrogen"]);
  const tight = onePattern(["free nitro"], { ...DEFAULT_DISGUISE, gaps: false });
  assertCatches(tight, ["free nitro", "freenitro"]);
});

Deno.test("the examples the builder shows are all caught", () => {
  const combos: DisguiseOptions[] = [
    DEFAULT_DISGUISE,
    { ...DEFAULT_DISGUISE, accents: true },
    { ...DEFAULT_DISGUISE, wholeWord: false },
    { numbers: true, lookalikes: false, accents: true, repeats: true, gaps: false, wholeWord: true },
  ];
  for (const o of combos) {
    for (const word of ["scam", "free nitro", "hello", "idiot", "kys"]) {
      const [pattern] = wordPatterns([word], o).patterns;
      const examples = disguiseExamples(word, o);
      assert(examples.length > 0, `no examples for ${word}`);
      assertCatches(pattern, examples);
    }
  }
});

Deno.test("regex characters in a word are matched literally", () => {
  const p = onePattern(["c++"]);
  assertCatches(p, ["I write c++", "C++!"]);
  assertMisses(p, ["cc", "c"]);
});

Deno.test("words in scripts without spaces get no gaps between characters", () => {
  const body = disguisedWord("死ね", DEFAULT_DISGUISE);
  assert(!body.includes("[^a-z0-9]*"), body);
  const p = onePattern(["死ね"]);
  assertCatches(p, ["お前死ね", "死ね"]);
  assertMisses(p, ["死んでもいいね"]);
});

Deno.test("words are packed into as few patterns as fit Discord's limit", () => {
  const words = ["scam", "nitro", "steam", "gift", "free", "robux", "hack", "cheat", "boost", "crypto"];
  const built = wordPatterns(words, DEFAULT_DISGUISE);
  assert(built.patterns.length < words.length, `${built.patterns.length} patterns for ${words.length} words`);
  assertEquals(built.groups.flat(), words);
  for (const p of built.patterns) assert(p.length <= LIMITS.regexLength, `${p.length}: ${p}`);
  for (const w of words) {
    assert(built.patterns.some((p) => catches(p, `a ${w} b`)), `${w} isn't caught by any pattern`);
  }
});

Deno.test("a word too long for Discord even alone is reported, not cut off", () => {
  const long = "supercalifragilisticexpialidocious";
  const built = wordPatterns([long, "scam"], { ...DEFAULT_DISGUISE, accents: true });
  assertEquals(built.tooLong, [long]);
  assertEquals(built.patterns.length, 1);
});

Deno.test("repeated and blank entries are dropped", () => {
  assertEquals(wordPatterns(["scam", " SCAM ", "", "  "], DEFAULT_DISGUISE).patterns.length, 1);
  assertEquals(wordPatterns([], DEFAULT_DISGUISE), { patterns: [], groups: [], tooLong: [] });
});

// --- Links -------------------------------------------------------------------

Deno.test("server invites are caught, including spelled-out ones", () => {
  assertCatches(INVITE_LINKS.pattern, [
    "discord.gg/abc123",
    "join https://discord.gg/Abc-12",
    "discord.com/invite/abc",
    "https://discordapp.com/invite/abc",
    "discord . gg / abc",
    "discord dot gg slash abc",
    "discord(.)gg/abc",
    "dsc.gg/abc",
  ]);
  assertMisses(INVITE_LINKS.pattern, [
    "https://discord.com/channels/1/2",
    "I like discord",
    "discord.gg",
  ]);
});

Deno.test("any link means http, https or www", () => {
  assertCatches(ANY_LINK.pattern, ["https://example.com", "see http://x.y/z", "www.example.com"]);
  assertMisses(ANY_LINK.pattern, ["example", "www", "https:"]);
});

Deno.test("site patterns catch the site and its subdomains, not look-alike names", () => {
  const [p] = sitePatterns(["grabify.link"]).patterns;
  assertCatches(p, ["grabify.link/abc", "https://sub.grabify.link", "visit grabify.link."]);
  assertMisses(p, ["notgrabify.link", "grabify.links", "grabify"]);
});

Deno.test("sites are typed however people paste them", () => {
  assertEquals(cleanDomain("https://www.Example.com/path?x=1"), "example.com");
  assertEquals(cleanDomain("example.com."), "example.com");
  assertEquals(cleanDomain("not a domain"), null);
  assertEquals(cleanDomain("localhost"), null);
  assertEquals(sitePatterns(["", "nope"]).patterns, []);
});

Deno.test("the IP grabber list fits in one pattern and catches each site", () => {
  const built = sitePatterns(IP_GRABBER_SITES);
  assertEquals(built.patterns.length, 1);
  for (const site of IP_GRABBER_SITES) assertCatches(built.patterns[0], [`https://${site}/abc`]);
});

// --- Personal information ----------------------------------------------------

Deno.test("email addresses", () => {
  assertCatches(EMAILS.pattern, ["name@example.com", "mail first.last+tag@mail.co.uk now"]);
  assertMisses(EMAILS.pattern, ["@everyone", "name@", "me at home"]);
  assertCatches(SPELLED_EMAILS.pattern, [
    "name at gmail dot com",
    "name[at]gmail[dot]com",
    "name (at) gmail (dot) com",
  ]);
});

Deno.test("phone numbers, but not dates, times or Discord IDs", () => {
  assertCatches(PHONE_NUMBERS.pattern, [
    "+1 (555) 123-4567",
    "call 555-123-4567",
    "07700 900123",
    "+44 7700 900123",
    "5551234567",
    "+49 151 12345678",
    "06 12 34 56 78",
    "+91 98765 43210",
    "090-1234-5678",
  ]);
  assertMisses(PHONE_NUMBERS.pattern, [
    "2026-09-26",
    "12:30",
    "1234",
    "user 123456789012345678 was banned",
    "2026-09-26 12:30",
  ]);
});

Deno.test("IP addresses", () => {
  assertCatches(IP_ADDRESSES.pattern, ["192.168.0.1", "my ip is 10.0.0.255."]);
  assertMisses(IP_ADDRESSES.pattern, ["1.2.3", "version 1.2.3.4.5"]);
});

// --- Spam tricks -------------------------------------------------------------

Deno.test("zalgo, but not ordinary accents", () => {
  assertCatches(ZALGO.pattern, [ZALGO.example, "Z̷̢̛a"]);
  assertMisses(ZALGO.pattern, ["naïve café", "tiếng Việt"]);
});

Deno.test("invisible characters, but not emoji built with joiners", () => {
  assertCatches(INVISIBLE.pattern, ["sc​am", "ㅤ", "⠀", "a﻿b"]);
  assertMisses(INVISIBLE.pattern, ["👨‍👩‍👧 family", "hello"]);
});

Deno.test("emoji walls count emoji, flags and custom emoji", () => {
  const p = emojiWall(5);
  assertCatches(p, [
    "😀😀😀😀😀",
    "😀 😀 😀 😀 😀",
    "👍🏽👍🏽👍🏽👍🏽👍🏽",
    "❤️❤️❤️❤️❤️",
    "🇺🇸🇺🇸🇺🇸",
    "<:pepe:123><:pepe:123><a:dance:456><:pepe:123><:pepe:123>",
  ]);
  assertMisses(p, ["😀😀😀😀", "hi 😀 there 😀 and 😀 more 😀 text 😀"]);
});

Deno.test("letter spam is one letter held down", () => {
  const p = letterSpam(10);
  assertCatches(p, ["aaaaaaaaaa", "AAAAAAAAAAAA", "hellooooooooooo"]);
  assertMisses(p, ["aaaaaaaaa", "abababababababab"]);
  assert(letterSpam(999).length <= LIMITS.regexLength);
});

Deno.test("shouting is enough capitals and no lowercase at all", () => {
  const p = shouting(10);
  assertCatches(p, ["STOP SPAMMING THE CHAT", "WHY WOULD YOU DO THAT!!! 😡"]);
  assertMisses(p, ["Stop spamming the chat", "OK", "I LOVE THIS game", "LOL"]);
});

Deno.test("walls of blank lines", () => {
  const p = blankLines(5);
  assertCatches(p, ["hi\n\n\n\n\nthere", "hi\n \n \n \n \nthere"]);
  assertMisses(p, ["a\nb\nc\nd\ne\nf", "hi\n\nthere"]);
});

Deno.test("every preset fits Discord's limit and can be tried in the browser", () => {
  const all = [
    INVITE_LINKS.pattern,
    ANY_LINK.pattern,
    EMAILS.pattern,
    SPELLED_EMAILS.pattern,
    PHONE_NUMBERS.pattern,
    IP_ADDRESSES.pattern,
    ZALGO.pattern,
    INVISIBLE.pattern,
    emojiWall(30),
    letterSpam(10),
    shouting(10),
    blankLines(8),
  ];
  for (const p of all) {
    assert(p.length <= LIMITS.regexLength, `${p.length}: ${p}`);
    assert(toBrowserRegex(p).ok, p);
  }
});

// --- Trying patterns written by hand -----------------------------------------

Deno.test("Discord's case-insensitive default, and switching it off", () => {
  assert(catches("scam", "SCAM"));
  assert(!catches("(?-i)scam", "SCAM"));
  assert(catches("(?-i)scam", "scam"));
});

Deno.test("Rust spellings are translated", () => {
  assert(catches("a\\x{200B}b", "a​b"));
  assert(catches("\\U0001F600", "😀"));
  assert(catches("^\\pL+$", "héllo"));
  assert(catches("\\p{Greek}+", "αβγ"));
  assert(catches("\\#tag \\& more", "#tag & more"));
  assert(catches("(?P<word>abc)", "xabcx"));
  assert(catches("[]a]", "]"));
  assert(catches("\\Ahello\\z", "hello"));
  assert(!catches("\\Ahello\\z", "hello there"));
});

Deno.test("Discord's own examples from its help article", () => {
  assert(catches("[\\u2800-\\u28FF]+", "⠁⠃"));
  assert(catches("[\\p{Greek}--β]+", "α"));
  assert(!catches("[\\p{Greek}--β]+", "β"));
});

Deno.test("what can't be tried here says why, instead of guessing", () => {
  const verbose = toBrowserRegex("(?x) a b");
  assert(!verbose.ok && verbose.reason.includes("x"));
  assert(!toBrowserRegex("(abc").ok);
});

Deno.test("matches report where and what, up to a limit", () => {
  const m = findMatches(compile("cat"), "a cat and a CAT", 20);
  assertEquals(m, [{ index: 2, text: "cat" }, { index: 12, text: "CAT" }]);
  assertEquals(findMatches(compile("a"), "aaaa", 2).length, 2);
});
