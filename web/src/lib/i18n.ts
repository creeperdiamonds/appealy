// web/src/lib/i18n.ts
//
// Locale for the console, taken from the URL rather than the browser.
//
// WHY THE URL AND NOT navigator.language
//
// A language chosen by the browser cannot be linked to. "Open the Japanese
// dashboard" has to be a URL someone can paste into a message, bookmark, or
// put in a docs page — and it has to survive being opened on a machine whose
// browser is set to English. /ja/dashboard/ is that URL. The browser's own
// preference is still honoured, but only to decide where to send someone who
// arrived without expressing a preference at all.
//
// WHY THE DICTIONARY IS KEYED ON ENGLISH
//
// The alternative is invented keys — t("forms.empty.title") — which means
// reading the source tells you nothing about what the screen says, and a
// missing key renders as the key. Keying on the English sentence makes the
// source readable as prose, makes a missing translation fall back to correct
// English rather than to debug output, and makes it impossible to have a key
// with no English behind it.
//
// The cost, stated plainly: two identical English strings that need different
// Japanese cannot be distinguished. If that ever happens the fix is to vary
// the English, which is usually the right fix anyway — if two places need
// different translations they were probably saying different things.

import { ja } from "./locales/ja";

export type Locale = "en" | "ja";

/** Every locale the console ships, and the dictionary for each. */
const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en: {},
  ja,
};

/**
 * The path prefix that selects a locale.
 *
 * "" for English, so the English console keeps its existing URLs exactly —
 * this feature must not move anybody's bookmarks.
 */
const PREFIXES: Record<Locale, string> = {
  en: "",
  ja: "/ja",
};

let current: Locale = "en";

/** Reads the locale out of a pathname. Exported for tests. */
export function localeFromPath(pathname: string): Locale {
  for (const [locale, prefix] of Object.entries(PREFIXES) as [Locale, string][]) {
    if (prefix && (pathname === prefix || pathname.startsWith(prefix + "/"))) {
      return locale;
    }
  }
  return "en";
}

/**
 * Decides the locale once, before the first render.
 *
 * Called from main.tsx for the same reason initTheme() is: deciding this
 * inside a component means React paints English first and swaps a frame
 * later, which is a visible flicker on every load.
 */
export function initLocale(): Locale {
  current = localeFromPath(window.location.pathname);
  document.documentElement.lang = current;
  return current;
}

export function getLocale(): Locale {
  return current;
}

/**
 * The console's base path for the active locale.
 *
 * /dashboard/ in English, /ja/dashboard/ in Japanese. Every route the app
 * builds goes through this, so switching locale never produces a URL that
 * routes to the wrong screen.
 */
export function basePath(): string {
  return `${PREFIXES[current]}/dashboard/`;
}

/** The same screen in the other language, for the switcher. */
export function switchLocalePath(to: Locale): string {
  const rest = window.location.pathname.replace(/^\/ja/, "").replace(/^\/dashboard\/?/, "");
  return `${PREFIXES[to]}/dashboard/${rest}${window.location.hash}`;
}

/**
 * Translates, falling back to the English it was given.
 *
 * The fallback is the point: an untranslated string renders as correct
 * English rather than as a key or an empty space, so a half-finished
 * translation degrades into a mixed-language screen instead of a broken one.
 */
export function t(english: string): string {
  return DICTIONARIES[current][english] ?? english;
}

/**
 * How much of the interface exists in the active locale.
 *
 * Exported so a coverage check can assert against the real dictionary rather
 * than against a count someone wrote down and let go stale.
 */
export function dictionarySize(locale: Locale): number {
  return Object.keys(DICTIONARIES[locale]).length;
}
