// api/src/services/paddleService.ts
//
// Creates Paddle transactions for arbitrary, computed annual amounts.
//
// WHY THIS EXISTS AT ALL
//
// Tebex's Checkout API accepts a price chosen at request time, which is the
// one thing this project's pricing needs (shared/schema/pricing.ts computes a
// different number for every custom plan). Tebex restricts that API to
// registered businesses; this project is a sole trader, and Tebex offered
// their Headless API instead. Headless sells packages that already exist in
// the store at prices set in their panel — there is no price field on any of
// its endpoints — so it cannot express a computed plan at all.
//
// Paddle takes a "non-catalog" price inline on a transaction: a name, a
// unit_price in minor units, and a billing_cycle. That is the same freedom the
// Tebex Checkout API gave us, and Paddle onboards individuals and sole traders
// without incorporation. Nothing about the pricing model changes: pricing.ts
// still computes the number and this file still just hands it over.
//
// WHAT TRAVELS WITH THE PURCHASE
//
// The plan being bought goes in the transaction's custom_data, which Paddle
// echoes back on every webhook about it and copies onto the subscription the
// transaction creates. routes/paddleWebhook.ts reads it there and nowhere
// else — the webhook's signature proves where a message came from, not what
// we meant to sell, so the amount is checked separately against a fresh
// recalculation.

import { Environment, LogLevel, Paddle } from "@paddle/paddle-node-sdk";

import { env } from "../env.ts";
import type { FullQuote, FullQuoteInput } from "../../../shared/schema/pricing.ts";

/**
 * What we attach to the transaction, and therefore what comes back on every
 * webhook about it. Kept small and entirely server-set.
 *
 * Every value is a string: Paddle stores custom_data as arbitrary JSON, and
 * keeping the shape flat and stringly-typed means nothing depends on how it
 * survives a round trip.
 */
export interface PaddleTransactionCustom {
  guildId: string;
  userId: string;
  rateLimitTier: string;
  hostingMode: string;
  /** JSON string rather than a nested object, for the reason above. */
  customCaps: string;
  /** Integer cents charged at checkout. A renewal bills the same price, and
   *  the webhook honours this amount when pricing.ts has changed since. */
  quotedCents: string;
}

export interface CreateCheckoutArgs {
  guildId: string;
  userId: string;
  plan: FullQuoteInput;
  quote: FullQuote;
}

export interface CreatedCheckout {
  checkoutUrl: string;
  /** Paddle's id for the transaction, txn_... — the Tebex equivalent was the
   *  basket ident. */
  transactionId: string;
}

/**
 * Whether Paddle is usable at all, judged before a request is attempted.
 *
 * "The API key is set" was the old test, and it was wrong: the key arrived
 * before the Paddle account could sell anything, so checkout switched to a
 * provider that answered every request with an error while Tebex sat working
 * and unused.
 *
 * The key's own prefix says which environment it belongs to, so a key that
 * disagrees with PADDLE_ENV is a misconfiguration we can catch here rather
 * than discover at checkout: a sandbox key in production talks to the wrong
 * account entirely, and a live key with PADDLE_ENV=sandbox points Paddle.js at
 * an environment the credential is not valid for.
 *
 * This is necessary, not sufficient — whether Paddle can actually create a
 * transaction today depends on account state (an approved checkout domain and
 * a default payment link), which no local check can see. routes/billing.ts
 * treats a refusal as the answer to that and falls back.
 */
export function paddleReady(): { ready: boolean; reason?: string } {
  const key = env.PADDLE_API_KEY;
  if (!key) return { ready: false, reason: "PADDLE_API_KEY is not set" };

  const wantsProduction = env.PADDLE_ENV === "production";
  const keyIsSandbox = key.startsWith("pdl_sdbx_");

  if (wantsProduction && keyIsSandbox) {
    return { ready: false, reason: "PADDLE_ENV is production but the API key is a sandbox key" };
  }
  if (!wantsProduction && !keyIsSandbox) {
    return { ready: false, reason: "PADDLE_ENV is sandbox but the API key is not a sandbox key" };
  }
  return { ready: true };
}

let client: Paddle | null = null;

function paddle(): Paddle {
  if (client) return client;
  if (!env.PADDLE_API_KEY) {
    throw new Error("PADDLE_API_KEY is not set; Paddle checkout is unavailable.");
  }
  client = new Paddle(env.PADDLE_API_KEY, {
    environment: env.PADDLE_ENV === "production" ? Environment.production : Environment.sandbox,
    logLevel: LogLevel.error,
  });
  return client;
}

/**
 * Prices cross this boundary as a string of minor units.
 *
 * Everything inside this codebase is integer cents (see
 * shared/schema/pricing.ts), and Paddle also works in minor units — unlike
 * Tebex, which took a decimal float and needed a conversion here. Paddle wants
 * that integer as a string, so the only change is the type, not the value.
 */
function centsToMinorUnits(cents: number): string {
  return String(Math.round(cents));
}

/**
 * The SDK's item type, derived from its own method signature rather than
 * imported by name: the union has a "catalog price id" arm and a "non-catalog
 * price" arm, and an unannotated object literal widens ("USD" to string) and
 * then matches neither, which tsc reports as a missing priceId.
 */
type TransactionItem = Parameters<Paddle["transactions"]["create"]>[0]["items"][number];

/** One inline, non-catalog yearly subscription item. */
function annualItem(name: string, cents: number): TransactionItem {
  return {
    quantity: 1,
    price: {
      name,
      description: name,
      // This is what makes renewals exist: Paddle bills this again every year
      // and emits the subscription events routes/paddleWebhook.ts acts on.
      billingCycle: { interval: "year" as const, frequency: 1 },
      unitPrice: { amount: centsToMinorUnits(cents), currencyCode: "USD" },
      // Non-catalog product too, so nothing has to be pre-created in the
      // Paddle dashboard for a plan priced per customer.
      product: {
        name,
        // Appealy is software sold as a service. The tax category decides the
        // VAT/sales-tax treatment Paddle applies as merchant of record, so it
        // is stated rather than defaulted.
        taxCategory: "saas" as const,
      },
    },
  };
}

export async function createPaddleCheckout(args: CreateCheckoutArgs): Promise<CreatedCheckout> {
  const { guildId, userId, plan, quote } = args;

  const items: TransactionItem[] = [];

  if (quote.throughput.price.annualUsdCents > 0) {
    items.push(
      annualItem(
        plan.rateLimitTier === "custom"
          ? "Appealy — Custom throughput plan (annual)"
          : `Appealy — ${plan.rateLimitTier} throughput plan (annual)`,
        quote.throughput.price.annualUsdCents,
      ),
    );
  }

  if (quote.hosting.price) {
    items.push(annualItem("Appealy — Dedicated hosted instance (annual)", quote.hosting.price.annualUsdCents));
  }

  if (items.length === 0) {
    throw new Error("Refusing to create a checkout with no chargeable items.");
  }

  const customData: PaddleTransactionCustom = {
    guildId,
    userId,
    rateLimitTier: plan.rateLimitTier,
    hostingMode: plan.hostingMode,
    customCaps: plan.customCaps ? JSON.stringify(plan.customCaps) : "",
    quotedCents: String(quote.totalUsdCentsPerYear),
  };

  // No customer is created here. Paddle collects the name, email and address
  // it needs during checkout itself, and this project deliberately stores no
  // email — the Discord OAuth scopes are identify and guilds.
  const created = await paddle().transactions.create({
    items,
    // Spread rather than passed directly: Paddle types custom_data as an
    // index-signature record, and a TypeScript interface does not satisfy one.
    customData: { ...customData },
  });

  // Paddle returns a checkout link on the transaction once the account has a
  // default payment link configured. Before that exists (a fresh sandbox
  // account), PADDLE_CHECKOUT_URL names the hosted checkout page and the
  // transaction id is appended to it.
  const checkoutUrl =
    created.checkout?.url ??
    (env.PADDLE_CHECKOUT_URL
      ? `${env.PADDLE_CHECKOUT_URL}${env.PADDLE_CHECKOUT_URL.includes("?") ? "&" : "?"}transaction_id=${created.id}`
      : null);

  if (!checkoutUrl) {
    // Sending an admin to "undefined" is worse than telling them the checkout
    // could not be created, and this failure means configuration, not a bug:
    // either set a default payment link in Paddle or set PADDLE_CHECKOUT_URL.
    throw new Error(
      `Paddle returned no checkout link for transaction ${created.id}, and PADDLE_CHECKOUT_URL is unset.`,
    );
  }

  return { checkoutUrl, transactionId: created.id };
}

/**
 * Stops a subscription from billing again.
 *
 * `when` is the whole decision, and it maps onto the refund window:
 *
 *   immediately          inside the 14 days. The plan ends now and Paddle
 *                        refunds; used by the downgrade path.
 *   next_billing_period  past the window. The year already paid for runs to
 *                        its end and nothing is charged after it.
 *
 * Deliberately NOT a refund call. Paddle is the merchant of record, so the
 * money is theirs to return and the customer asks them — see site/refunds.html.
 * Cancelling here only stops the future charge.
 *
 * Nothing in this service cancelled anything before today, which meant
 * "downgrade to free" cleared the plan in our database and left the
 * subscription billing yearly, forever, with the guild already on free.
 */
export async function cancelPaddleSubscription(
  subscriptionId: string,
  when: "immediately" | "next_billing_period",
): Promise<void> {
  await paddle().subscriptions.cancel(subscriptionId, { effectiveFrom: when });
}

/**
 * Repoints a live subscription at a different guild.
 *
 * Two places record which guild a subscription belongs to, and both have to
 * move or they disagree:
 *
 *   1. guilds.paddle_subscription_id, which is how the webhook finds the
 *      guild for a renewal or cancellation (routes/paddleWebhook.ts).
 *   2. the subscription's own custom_data at Paddle, which is what a human
 *      reads in their dashboard and what a future handler might trust.
 *
 * Only custom_data is sent. subscriptions.update removes any item omitted
 * from an `items` array, so touching items here would silently empty the
 * subscription — the API reference calls this out explicitly.
 */
export async function repointPaddleSubscription(
  subscriptionId: string,
  toGuildId: string,
): Promise<void> {
  await paddle().subscriptions.update(subscriptionId, {
    customData: { guildId: toGuildId },
  });
}
