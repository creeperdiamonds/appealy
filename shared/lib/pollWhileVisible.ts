// shared/lib/pollWhileVisible.ts
//
// Repeats a load while the page is on screen, and pauses it while it isn't.
// Browsers only slow a hidden tab's timers down, so without the check an interval
// keeps running behind a tab nobody is looking at. Coming back loads straight
// away, so what's on screen is never a whole interval old.
//
// In shared/ rather than web/src because this is where the tests run.

/** The parts of `document` this needs. Passed in so tests don't need a browser. */
export interface PageVisibility {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Starts polling and returns the function that stops it. Doesn't load right away. */
export function pollWhileVisible(load: () => void, everyMs: number, page: PageVisibility): () => void {
  const loadIfVisible = () => {
    if (page.visibilityState === "visible") load();
  };
  const timer = setInterval(loadIfVisible, everyMs);
  page.addEventListener("visibilitychange", loadIfVisible);
  return () => {
    clearInterval(timer);
    page.removeEventListener("visibilitychange", loadIfVisible);
  };
}
