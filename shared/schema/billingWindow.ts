// shared/schema/billingWindow.ts
//
// When a paid plan may still be undone, and what "undone" means after that.
//
// There is exactly one refund window — 14 days, stated on site/refunds.html
// and in the Terms — and three places need to agree about whether it is open:
// the route that acts, the dashboard that offers the button, and the copy that
// explains it. Two copies of this arithmetic would drift, and the direction it
// would drift is "the UI offers something the API refuses", which reads as a
// broken product rather than a policy.
//
// WHY THE PURCHASE DATE IS DERIVED
//
// Billing is annual-only (see pricing.ts for why), and every successful
// payment sets customBillingRenewsAt to exactly one year out —
// services/billingService.ts. So the purchase is renewsAt minus a year, with
// no column to add and nothing that can fall out of step with the payment
// that set it.
//
// A renewal moves renewsAt forward, which restarts the window. That is
// correct rather than convenient: a renewal is a fresh payment, and a fresh
// payment gets a fresh 14 days to change your mind.

/** Days after purchase in which a refund may be asked for, no reason needed. */
export const REFUND_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

export interface BillingWindow {
  /** False for a guild on the free selection — nothing was paid. */
  paid: boolean;
  /** When the current period was paid for. Null when nothing was. */
  purchasedAt: Date | null;
  /** Last moment a refund can be asked for. Null when nothing was paid. */
  refundableUntil: Date | null;
  /**
   * True inside the 14 days. This is the only state in which dropping to the
   * free selection is offered, because it is the only state in which the
   * money can come back.
   */
  refundable: boolean;
  /**
   * What the person can still do about the money.
   *
   *   downgrade       inside the window — cancel now and ask Paddle to refund
   *   cancel-renewal  past it — keep the year that is paid for, stop the next
   *   none            nothing is paid, so there is nothing to stop
   */
  action: "downgrade" | "cancel-renewal" | "none";
}

/**
 * Reads the window from the renewal date alone.
 *
 * `now` is injectable so a test can sit on either side of the boundary
 * without waiting fourteen days.
 */
export function billingWindow(
  customBillingRenewsAt: Date | string | null | undefined,
  now: Date = new Date(),
): BillingWindow {
  if (!customBillingRenewsAt) {
    return {
      paid: false,
      purchasedAt: null,
      refundableUntil: null,
      refundable: false,
      action: "none",
    };
  }

  const renews =
    customBillingRenewsAt instanceof Date
      ? customBillingRenewsAt
      : new Date(customBillingRenewsAt);

  const purchasedAt = new Date(renews.getTime() - YEAR_MS);
  const refundableUntil = new Date(purchasedAt.getTime() + REFUND_WINDOW_DAYS * DAY_MS);
  const refundable = now.getTime() <= refundableUntil.getTime();

  return {
    paid: true,
    purchasedAt,
    refundableUntil,
    refundable,
    action: refundable ? "downgrade" : "cancel-renewal",
  };
}
