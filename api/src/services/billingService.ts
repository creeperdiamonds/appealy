// api/src/services/billingService.ts
//
// The ONLY place a guild's billing columns are written after a paid plan
// change. Called exclusively from routes/tebexWebhook.ts once Tebex has
// confirmed a payment succeeded — never from a route that only has
// unverified client input. Keeping this here makes it possible to audit every
// code path that can move money-adjacent state with a single grep.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { calculateFullQuote, type FullQuoteInput } from "../../../shared/schema/pricing.ts";
import { logger } from "../utils/logger.ts";

export interface ApplyPlanChangeResult {
  applied: boolean;
  reason?: "invalid_plan" | "guild_not_found";
}

export async function applyPlanChange(
  guildId: bigint,
  plan: FullQuoteInput,
  /** Tebex's handle for the subscription behind this payment, so its later
   *  lifecycle events can be matched back to this guild. Null for a payment
   *  with no recurring component. */
  recurringReference: string | null = null,
): Promise<ApplyPlanChangeResult> {
  // Re-validate server-side even though this is only called post-payment —
  // a webhook's custom data should never be trusted as automatically valid
  // just because a payment succeeded against it. If this ever fails here,
  // something upstream (basket construction) let an invalid plan through,
  // which is itself worth alerting on in a real deployment.
  const quote = calculateFullQuote(plan);
  if (!quote.valid) {
    return { applied: false, reason: "invalid_plan" };
  }

  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  if (!guild) {
    return { applied: false, reason: "guild_not_found" };
  }

  const updateSet: Record<string, unknown> = {
    rateLimitTier: plan.rateLimitTier,
    customRateLimits: plan.rateLimitTier === "custom" ? plan.customCaps ?? {} : null,
    hostingMode: plan.hostingMode,
    updatedAt: new Date(),
  };

  // Every paid plan here is billed annually (see shared/schema/pricing.ts for
  // why) — a successful payment always anchors a fresh one-year renewal
  // window, whichever axis triggered the charge. A renewal arrives as another
  // payment against the same subscription and lands here again, which is what
  // moves the window forward rather than letting it quietly expire.
  const paid = plan.hostingMode === "custom" || plan.rateLimitTier !== "free";
  updateSet.customBillingRenewsAt = paid
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    : null;

  // Only ever set, never cleared here: a renewal arriving without one should
  // not wipe the reference the original payment established.
  if (recurringReference) {
    updateSet.tebexRecurringReference = recurringReference;
  }

  await db.update(schema.guilds).set(updateSet).where(eq(schema.guilds.id, guildId));

  return { applied: true };
}

/**
 * Returns a guild to the free selection because its paid plan stopped.
 *
 * Separate from applyPlanChange because this is not a plan *change* the
 * customer chose — it is the absence of one, and the two want different
 * logging. The subscription-ended and refunded webhooks call this, and it is
 * the half the previous integration never had: a plan bought once stayed
 * bought, whatever happened afterwards.
 */
export async function endPaidPlan(
  guildId: bigint,
  reason: "subscription_ended" | "refunded",
): Promise<void> {
  await db
    .update(schema.guilds)
    .set({
      rateLimitTier: "free",
      customRateLimits: null,
      hostingMode: "shared",
      customBillingRenewsAt: null,
      // Cleared so a later event for the same dead subscription cannot match
      // this guild again.
      tebexRecurringReference: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.guilds.id, guildId));

  logger.info("Paid plan ended", { guildId: guildId.toString(), reason });
}
