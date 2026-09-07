// web/src/lib/theme.ts
//
// Which ground the console is on, and how it gets from one to the other.
//
// Three states, not two. "system" is the default and stamps NOTHING on the
// root element, so the CSS resolves it through prefers-color-scheme. An
// explicit choice stamps data-theme, which the stylesheet is written to let
// win in both directions. Treating this as a boolean is the usual bug: it
// makes "follow my phone" unreachable once someone has ever pressed the
// toggle, and the phone is the surface this console is designed for.

export type ThemeChoice = "system" | "light" | "dark";
export type Ground = "light" | "dark";

const KEY = "appealy:theme";

/** What the OS says right now. */
export function systemGround(): Ground {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function storedChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // Private mode, or site data blocked. Not an error worth surfacing —
    // the console works, it just forgets the preference between visits.
  }
  return "system";
}

/** The ground a choice actually resolves to. */
export function groundFor(choice: ThemeChoice): Ground {
  return choice === "system" ? systemGround() : choice;
}

// Kept in step with the --bg token for each ground in index.css. Duplicated
// rather than read back from the computed style: this has to be applied in the
// same frame as the stamp, and getComputedStyle there returns the OLD value
// often enough to produce a one-frame flash of the wrong colour in the address
// bar — which is the exact artefact this function exists to prevent.
const BG: Record<Ground, string> = {
  dark: "#0d1016",
  light: "#f5f6f8",
};

/**
 * Put a choice into effect.
 *
 * `animate` is false on first paint — crossfading from nothing into the page
 * the user asked for is a flash, not a transition.
 */
export function applyTheme(choice: ThemeChoice, animate = true): void {
  const root = document.documentElement;
  const ground = groundFor(choice);

  const commit = () => {
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);

    // The browser's own chrome. Without this the address bar stays the old
    // theme for a beat and you get a light strip above a dark app.
    // index.html ships two media-scoped theme-color tags so the very first
    // frame is right. Once a choice is in play they are wrong — a `media`
    // tag still wins for whichever query matches, regardless of what an
    // unscoped tag says — so they are removed rather than added to, and one
    // unscoped tag owns it from here.
    document
      .querySelectorAll('meta[name="theme-color"][media]')
      .forEach((el) => el.remove());

    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = BG[ground];
  };

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduced) {
    commit();
    return;
  }

  // The good path, where the browser has it: a real crossfade of the rendered
  // frame, done by the compositor rather than by transitioning every element.
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> };
  };
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(commit);
    return;
  }

  // The fallback. Scoped to the duration and then removed — see the comment on
  // .theme-switching in index.css for why it must not be left on.
  root.classList.add("theme-switching");
  commit();
  window.setTimeout(() => root.classList.remove("theme-switching"), 200);
}

/**
 * Call once, before React mounts.
 *
 * Also starts listening to the OS, because "system" has to keep meaning system
 * — a phone that flips to dark at sunset should take the console with it, and
 * only while the user has not overridden it.
 */
export function initTheme(): void {
  applyTheme(storedChoice(), false);

  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (storedChoice() === "system") applyTheme("system", false);
  });
}

/** Persist and apply. Returns what was set, so callers need not re-read. */
export function setTheme(choice: ThemeChoice): ThemeChoice {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Preference is not persisted; the current session still switches.
  }
  applyTheme(choice, true);
  return choice;
}

/**
 * The order the toggle walks: system → light → dark → system.
 *
 * System stays in the cycle rather than being buried in a settings screen.
 * It is the default and the one people want back after trying the other two,
 * and a toggle you cannot get back to the default with is a trap.
 */
export function nextChoice(current: ThemeChoice): ThemeChoice {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}
