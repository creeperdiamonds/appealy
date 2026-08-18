// api/src/services/tebexService.ts
//
// Creates Tebex Checkout baskets for arbitrary, computed annual amounts.
//
// WHY TEBEX AND NOT A CARD PROCESSOR DIRECTLY
//
// Tebex is merchant of record. It sells to the customer, collects the money,
// and handles sales tax and VAT registration and remittance in every
// jurisdiction it sells into. Taking card payments directly means being the
// merchant yourself, which starts with providing a taxpayer identification
// number — a US processor asks for an SSN or ITIN for an individual, an EIN
// for a company — and continues with owning tax registration wherever your
// customers are. Merchant of record moves both of those off this project.
//
// THE THING THE OLD COMMENTS SAID WAS IMPOSSIBLE
//
// This project previously used Stripe and recorded, in several places, that
// Tebex had been "evaluated and ruled out because it can't accept an
// arbitrary computed price without pre-created SKUs". That is no longer
// true — and the custom-caps tier is exactly the case that needed it.
// POST /checkout takes items with an inline `package` carrying a `name` and a
// `price` chosen at request time, which is the same shape of freedom
// Stripe's price_data gave us. Nothing about the pricing model had to change
// to move: shared/schema/pricing.ts still computes the number, and this file
// still just hands it over.
//
// The plan being bought travels in the basket's `custom` object, which Tebex
// echoes back on the webhooks for this basket. routes/tebexWebhook.ts reads
// it there and nowhere else — see the note in that file about why a webhook's
// contents are proof of origin, not proof of intent.

import { env } from "../env.ts";
import type { FullQuote, FullQuoteInput } from "../../../shared/schema/pricing.ts";

const API_BASE = "https://checkout.tebex.io/api";

/**
 * What we attach to the basket, and therefore what comes back on every
 * webhook about it. Kept deliberately small and entirely server-set.
 */
export interface TebexBasketCustom {
  guildId: string;
  userId: string;
  rateLimitTier: string;
  hostingMode: string;
  /** JSON string rather than a nested object, so the shape survives whatever
   *  Tebex does to arbitrary custom data on the way back. */
  customCaps: string;
}

interface TebexBasketResponse {
  ident: string;
  links?: { checkout?: string; payment?: string };
}

export interface CreateCheckoutArgs {
  guildId: string;
  userId: string;
  plan: FullQuoteInput;
  quote: FullQuote;
}

export interface CreatedCheckout {
  checkoutUrl: string;
  basketIdent: string;
}

function authHeader(): string {
  // Basic auth. The pair is the project's public token and its private key,
  // from creator.tebex.io -> Developers -> API Keys. Both are configured
  // rather than derived because Tebex's docs name them differently in
  // different places, and guessing would fail at request time with a 401
  // that says nothing useful.
  const raw = `${env.TEBEX_PROJECT_ID}:${env.TEBEX_PRIVATE_KEY}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/**
 * Prices cross this boundary as decimal currency units, not integer cents.
 *
 * Everything inside this codebase is integer cents on purpose (see
 * shared/schema/pricing.ts). Tebex's API takes a float. Converting at the
 * single point where the value leaves us keeps the rule intact everywhere
 * else, and the reverse conversion in the webhook is the only other place
 * this happens.
 */
function centsToUnits(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

export async function createTebexCheckout(args: CreateCheckoutArgs): Promise<CreatedCheckout> {
  const { guildId, userId, plan, quote } = args;

  // Subscriptions rather than one-off charges, with a one-year period. This
  // is what makes renewals exist at all: Tebex emits recurring-payment events
  // the webhook uses to keep a plan alive or end it. The previous integration
  // had no expiry handling anywhere, so a plan bought once never lapsed.
  const items: Array<{ package: Record<string, unknown> }> = [];

  if (quote.throughput.price.annualUsdCents > 0) {
    items.push({
      package: {
        name:
          plan.rateLimitTier === "custom"
            ? "Appealy — Custom throughput plan (annual)"
            : `Appealy — ${plan.rateLimitTier} throughput plan (annual)`,
        price: centsToUnits(quote.throughput.price.annualUsdCents),
        type: "subscription",
        qty: 1,
        expiry_period: "year",
        expiry_length: 1,
        custom: { kind: "throughput", tier: plan.rateLimitTier },
      },
    });
  }

  if (quote.hosting.price) {
    items.push({
      package: {
        name: "Appealy — Dedicated hosted instance (annual)",
        price: centsToUnits(quote.hosting.price.annualUsdCents),
        type: "subscription",
        qty: 1,
        expiry_period: "year",
        expiry_length: 1,
        custom: { kind: "hosting" },
      },
    });
  }

  if (items.length === 0) {
    throw new Error("Refusing to create a checkout with no chargeable items.");
  }

  const custom: TebexBasketCustom = {
    guildId,
    userId,
    rateLimitTier: plan.rateLimitTier,
    hostingMode: plan.hostingMode,
    customCaps: plan.customCaps ? JSON.stringify(plan.customCaps) : "",
  };

  const body = {
    basket: {
      // Tebex collects the customer's real name and email during checkout
      // itself; these are placeholders it overwrites. Passing the Discord
      // account's email would mean storing one, which this project
      // deliberately does not — the OAuth scopes are identify and guilds.
      first_name: "Appealy",
      last_name: "Customer",
      email: "customer@appealy.invalid",
      return_url: `${env.FRONTEND_ORIGIN}/dashboard/${guildId}/billing?checkout=cancelled`,
      complete_url: `${env.FRONTEND_ORIGIN}/dashboard/${guildId}/billing?checkout=success`,
      complete_auto_redirect: true,
      custom,
    },
    items,
  };

  const res = await fetch(`${API_BASE}/checkout`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Surfaced with the status, because a 401 here means the API keys are
    // wrong and a 422 means we built the basket wrong, and those need very
    // different fixes.
    const detail = await res.text().catch(() => "");
    throw new Error(`Tebex checkout creation failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  const basket = (await res.json()) as TebexBasketResponse;
  const checkoutUrl = basket.links?.checkout;

  if (!checkoutUrl) {
    // A basket with no checkout link is one Tebex considers already paid or
    // otherwise unusable. Sending the admin nowhere is better than sending
    // them to undefined.
    throw new Error(`Tebex returned a basket with no checkout link (ident ${basket.ident}).`);
  }

  return { checkoutUrl, basketIdent: basket.ident };
}
