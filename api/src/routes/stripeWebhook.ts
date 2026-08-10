// api/src/routes/stripeWebhook.ts
//
// Receives Stripe's payment confirmation and is the ONLY place a paid plan
// change is actually applied (via services/billingService.ts). Three
// things this handler must get right, in order of how badly getting them
// wrong would go:
//
//   1. VERIFY THE SIGNATURE. Stripe signs every webhook with a secret only
//      you and Stripe know (stripe.webhooks.constructEvent below does
//      this using the raw, unparsed request body — never JSON.parse it
//      first, the signature is computed over the exact bytes Stripe sent).
//      Skipping this means anyone who finds this URL can POST a fake
//      "payment succeeded" event and get free service.
//
//   2. RE-DERIVE THE PLAN FROM METADATA, NEVER FROM A CLIENT REQUEST.
//      The plan being purchased travels in the Checkout Session's metadata
//      (set server-side in stripeService.ts, never editable by the
//      browser), not in anything the webhook's caller controls directly.
//
//   3. VERIFY THE CHARGED AMOUNT MATCHES WHAT THE PLAN SHOULD COST BEFORE
//      APPLYING IT. This is Tebex's own webhook documentation's warning
//      generalized to any processor: "verify that webhook contents always
//      match the items and amount you are expecting" — never assume a
//      webhook's subject/amount is trustworthy just because the signature
//      is valid; the signature proves it came from Stripe, not that the
//      amount matches what we intended to charge for that plan. If Stripe
//      says $6.00 was paid but recalculating the plan from metadata says
//      it should cost $60.00, something is wrong (a bug, a stale price, a
//      manipulated session) and the plan change must be refused rather
//      than applied at the wrong price.
//
// Mounted at /webhooks/stripe — NOT under /api/guilds, no session auth
// (Stripe isn't a logged-in dashboard user); authenticity comes entirely
// from the signature check.

import { Router, raw } from "express";
import { env } from "../env.ts";
import { stripe } from "../services/stripeService.ts";
import { applyPlanChange } from "../services/billingService.ts";
import { calculateFullQuote, type RateLimitTier, type HostingMode, type RateLimitCaps } from "../../../shared/schema/pricing.ts";

export const stripeWebhookRouter = Router();

// Stripe's signature is computed over the raw body bytes — express.json()
// would have already parsed and re-serialized it by the time a normal
// route sees it, which breaks verification. This route MUST be mounted
// before any global express.json() middleware, or with raw() applied
// specifically to it as done here, so req.body is a Buffer, not an object.
stripeWebhookRouter.post("/stripe", raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (!signature || typeof signature !== "string") {
    return res.status(400).send("Missing stripe-signature header");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Signature verification failed — this request did not genuinely come
    // from Stripe (or the body was tampered with in transit). Reject
    // outright; never fall through to processing an unverified payload.
    return res.status(400).send(`Webhook signature verification failed: ${String(err)}`);
  }

  // Only act on definitive success events. checkout.session.completed
  // fires once the Checkout Session's payment succeeds; for subscription
  // mode this is the right moment to apply the plan (Stripe has already
  // captured the first payment by this point).
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as import("stripe").default.Checkout.Session;
    await handleCheckoutCompleted(session);
  }

  // Always 2xx a recognized, signature-valid event even if we didn't act
  // on this particular type — Stripe retries on non-2xx, and retrying an
  // event type we deliberately ignore just wastes both sides' time.
  res.json({ received: true });
});

async function handleCheckoutCompleted(session: import("stripe").default.Checkout.Session) {
  const metadata = session.metadata;
  if (!metadata?.guildId || !metadata?.rateLimitTier || !metadata?.hostingMode) {
    // Missing expected metadata means this session wasn't created by
    // stripeService.ts's createCheckoutSession — refuse rather than guess.
    console.error(JSON.stringify({
      level: "error",
      msg: "Stripe webhook: checkout session missing expected metadata, refusing to apply any plan change",
      sessionId: session.id,
    }));
    return;
  }

  const plan = {
    rateLimitTier: metadata.rateLimitTier as RateLimitTier,
    hostingMode: metadata.hostingMode as HostingMode,
    customCaps: metadata.customCaps ? (JSON.parse(metadata.customCaps) as Partial<RateLimitCaps>) : undefined,
  };

  // Step 3 from the file header: recompute what this plan SHOULD cost and
  // compare against what Stripe says was actually charged. amount_total is
  // in cents already, matching our integer-cents convention throughout.
  const expectedQuote = calculateFullQuote(plan);
  const actualPaidCents = session.amount_total ?? 0;

  if (!expectedQuote.valid) {
    console.error(JSON.stringify({
      level: "error",
      msg: "Stripe webhook: recalculated plan is invalid (exceeds a cap ceiling), refusing to apply",
      sessionId: session.id,
      guildId: metadata.guildId,
    }));
    return;
  }

  if (actualPaidCents !== expectedQuote.totalUsdCentsPerYear) {
    // Amount mismatch — do NOT apply the plan change. This could be a
    // stale price on the client, a bug in quote-vs-checkout-session
    // construction, or an attempted manipulation. Either way, a human
    // needs to look at it before this guild's plan changes.
    console.error(JSON.stringify({
      level: "error",
      msg: "Stripe webhook: paid amount does not match recalculated plan price, refusing to apply",
      sessionId: session.id,
      guildId: metadata.guildId,
      actualPaidCents,
      expectedCents: expectedQuote.totalUsdCentsPerYear,
    }));
    return;
  }

  const result = await applyPlanChange(BigInt(metadata.guildId), plan);
  console.log(JSON.stringify({
    level: "info",
    msg: "Stripe webhook: plan change processed",
    sessionId: session.id,
    guildId: metadata.guildId,
    applied: result.applied,
    reason: result.reason,
  }));
}
