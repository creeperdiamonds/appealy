// shared/lib/__tests__/pollWhileVisible.test.ts
//
// Run with: deno test shared/lib/__tests__/pollWhileVisible.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.224.0/testing/time.ts";
import { pollWhileVisible } from "../pollWhileVisible.ts";

const EVERY_MS = 15_000;

class FakeDocument extends EventTarget {
  visibilityState = "visible";

  set(state: "visible" | "hidden") {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

Deno.test("polls on the interval while the page is on screen", () => {
  using time = new FakeTime();
  const doc = new FakeDocument();
  let loads = 0;
  const stop = pollWhileVisible(() => loads++, EVERY_MS, doc);

  time.tick(EVERY_MS * 3);

  assertEquals(loads, 3);
  stop();
});

// The bug this exists for: a comment on the Overview page said polling stopped
// here, and the interval kept running, about 12 database queries a time.
Deno.test("doesn't poll while the page is hidden", () => {
  using time = new FakeTime();
  const doc = new FakeDocument();
  let loads = 0;
  const stop = pollWhileVisible(() => loads++, EVERY_MS, doc);

  doc.set("hidden");
  time.tick(EVERY_MS * 100);

  assertEquals(loads, 0);
  stop();
});

Deno.test("loads straight away when the page comes back, then polls again", () => {
  using time = new FakeTime();
  const doc = new FakeDocument();
  let loads = 0;
  const stop = pollWhileVisible(() => loads++, EVERY_MS, doc);

  doc.set("hidden");
  time.tick(EVERY_MS * 2);
  doc.set("visible");
  assertEquals(loads, 1);

  time.tick(EVERY_MS);
  assertEquals(loads, 2);
  stop();
});

Deno.test("does nothing after it's stopped", () => {
  using time = new FakeTime();
  const doc = new FakeDocument();
  let loads = 0;
  const stop = pollWhileVisible(() => loads++, EVERY_MS, doc);

  stop();
  time.tick(EVERY_MS * 3);
  doc.set("hidden");
  doc.set("visible");

  assertEquals(loads, 0);
});
