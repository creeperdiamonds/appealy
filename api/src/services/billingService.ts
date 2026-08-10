// api/src/services/billingService.ts
//
// The ONLY place a guild's billing columns are written after a paid plan
// change. Called exclusively from routes/stripeWebhook.ts once Stripe has
// confirmed a payment succeeded — never from a route that only has
// unverified client input. Keeping this as one function makes it possible
// to audit every code path that can move money-adjacent state with a
// single grep for its name.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { calculateFullQuote, type FullQuoteInput } from "../../../shared/schema/pricing.ts";

export interface ApplyPlanChangeResult {
  applied: boolean;
  reason?: "invalid_plan" | "guild_not_found";
}

export async function applyPlanChange(
  guildId: bigint,
  plan: FullQuoteInput,
): Promise<ApplyPlanChangeResult> {
  // Re-validate server-side even though this is only called post-payment —
  // a webhook's metadata should never be trusted as automatically valid
  // just because a payment succeeded against it. If this ever fails here,
  // something upstream (checkout session creation) let an invalid plan
  // through, which is itself worth alerting on in a real deployment.
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

  // Every paid plan here is billed annually (see shared/schema/pricing.ts
  // for why) — a successful checkout always anchors a fresh one-year
  // renewal window, whichever axis triggered the charge.
  updateSet.customBillingRenewsAt =
    plan.hostingMode === "custom" || plan.rateLimitTier !== "free"
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : null;

  await db.update(schema.guilds).set(updateSet).where(eq(schema.guilds.id, guildId));

  return { applied: true };
}
