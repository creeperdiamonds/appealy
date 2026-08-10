// api/src/services/stripeService.ts
//
// Creates Stripe Checkout Sessions for arbitrary, computed annual amounts.
// Stripe's price_data (as opposed to a pre-created Price object) is what
// makes this workable for our custom-caps tier: unlike a fixed-package
// storefront, Stripe lets us hand it a one-off amount computed at request
// time, which is exactly what shared/schema/pricing.ts produces. This is
// the reason this project uses Stripe rather than a package-catalog-based
// processor for the custom-caps case specifically.
//
// The chosen plan is embedded in the session's metadata (never trusted
// from any other source at webhook time) so routes/stripeWebhook.ts can
// recover exactly what was purchased without re-deriving it from
// arbitrary webhook content — see the warning there about why webhook
// payloads must be checked against what you expected, not trusted outright.

import Stripe from "stripe";
import { env } from "../env.ts";
import type { FullQuote, FullQuoteInput } from "../../../shared/schema/pricing.ts";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

export interface CreateCheckoutSessionArgs {
  guildId: string;
  userId: string;
  plan: FullQuoteInput;
  quote: FullQuote;
}

export async function createCheckoutSession(args: CreateCheckoutSessionArgs): Promise<Stripe.Checkout.Session> {
  const { guildId, userId, plan, quote } = args;

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];

  if (quote.throughput.price.annualUsdCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: quote.throughput.price.annualUsdCents,
        recurring: { interval: "year" },
        product_data: {
          name:
            plan.rateLimitTier === "custom"
              ? "Appealy — Custom throughput plan (annual)"
              : `Appealy — ${plan.rateLimitTier} throughput plan (annual)`,
          metadata: { kind: "throughput", tier: plan.rateLimitTier },
        },
      },
    });
  }

  if (quote.hosting.price) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: quote.hosting.price.annualUsdCents,
        recurring: { interval: "year" },
        product_data: {
          name: "Appealy — Dedicated hosted instance (annual)",
          metadata: { kind: "hosting" },
        },
      },
    });
  }

  if (lineItems.length === 0) {
    throw new Error("Refusing to create a checkout session with no chargeable line items.");
  }

  // Metadata travels with the resulting Subscription/PaymentIntent and is
  // what the webhook reads to know which guild and which exact plan this
  // payment corresponds to — plain strings only, Stripe metadata values
  // must be strings.
  const metadata: Record<string, string> = {
    guildId,
    userId,
    rateLimitTier: plan.rateLimitTier,
    hostingMode: plan.hostingMode,
    customCaps: plan.customCaps ? JSON.stringify(plan.customCaps) : "",
  };

  return stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    success_url: `${env.FRONTEND_ORIGIN}/dashboard/${guildId}/billing?checkout=success`,
    cancel_url: `${env.FRONTEND_ORIGIN}/dashboard/${guildId}/billing?checkout=cancelled`,
    client_reference_id: guildId,
    metadata,
    subscription_data: { metadata },
  });
}

export { stripe };
