// shared/schema/__tests__/billingWindow.test.ts
//
// The refund window decides whether a button appears, whether a route refuses,
// and whether a subscription is cancelled immediately or at period end. All
// three read the same helper, so a boundary error here is a money error in
// three places at once — which is why it gets tests rather than a once-over.
//
// The dates are constructed relative to `now` rather than written literally,
// so these do not start failing in a year.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { billingWindow, REFUND_WINDOW_DAYS } from "../billingWindow.ts";

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;

/** A renewal date implying a purchase `daysAgo` days back. */
function renewsAfterPurchase(now: Date, daysAgo: number): Date {
  return new Date(now.getTime() - daysAgo * DAY + YEAR);
}

Deno.test("a guild on the free selection has nothing to stop", () => {
  const w = billingWindow(null);
  assertEquals(w.paid, false);
  assertEquals(w.refundable, false);
  assertEquals(w.action, "none");
  assertEquals(w.purchasedAt, null);
});

Deno.test("a purchase today is refundable, and offers downgrade", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const w = billingWindow(renewsAfterPurchase(now, 0), now);
  assertEquals(w.paid, true);
  assertEquals(w.refundable, true);
  assertEquals(w.action, "downgrade");
});

Deno.test("the purchase date is derived from the renewal, a year back", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const w = billingWindow(renewsAfterPurchase(now, 10), now);
  assertEquals(w.purchasedAt?.toISOString(), new Date(now.getTime() - 10 * DAY).toISOString());
});

Deno.test("the last day of the window is still refundable", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  // Exactly on the boundary: purchased REFUND_WINDOW_DAYS ago.
  const w = billingWindow(renewsAfterPurchase(now, REFUND_WINDOW_DAYS), now);
  assertEquals(w.refundable, true, "the boundary itself must be inside the window");
  assertEquals(w.action, "downgrade");
});

Deno.test("a minute past the window closes it, and switches to cancel-renewal", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const justPast = new Date(renewsAfterPurchase(now, REFUND_WINDOW_DAYS).getTime() - 60_000);
  const w = billingWindow(justPast, now);
  assertEquals(w.refundable, false);
  assertEquals(w.action, "cancel-renewal", "past the window, the money is not coming back");
});

Deno.test("an old plan is not refundable but can still stop renewing", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const w = billingWindow(renewsAfterPurchase(now, 200), now);
  assertEquals(w.paid, true);
  assertEquals(w.refundable, false);
  assertEquals(w.action, "cancel-renewal");
});

Deno.test("a renewal restarts the window, because it is a fresh payment", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  // A renewal sets renewsAt to a year out from the moment it was paid.
  const renewedToday = new Date(now.getTime() + YEAR);
  const w = billingWindow(renewedToday, now);
  assertEquals(w.refundable, true);
  assertEquals(w.action, "downgrade");
});

Deno.test("an ISO string is accepted, since that is what the API sends", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const iso = renewsAfterPurchase(now, 1).toISOString();
  assertEquals(billingWindow(iso, now).refundable, true);
});
