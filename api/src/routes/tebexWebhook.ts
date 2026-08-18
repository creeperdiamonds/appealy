// api/src/routes/tebexWebhook.ts
//
// Receives Tebex's payment notifications and is the ONLY place a paid plan
// change is applied (via services/billingService.ts). Four things this
// handler must get right, in order of how badly getting them wrong would go:
//
//   1. VERIFY THE SIGNATURE, OVER THE RAW BYTES. Tebex signs every webhook
//      with a secret only it and we know. The signature is an HMAC-SHA256,
//      keyed with the webhook secret, over the SHA256 hex digest of the raw
//      JSON body — not over the body directly, which is an easy detail to get
//      subtly wrong and then "fix" by disabling the check. Tebex's own docs
//      call out Express specifically here: express.json() parses and
//      re-serialises, and a re-serialised body does not hash to the same
//      value. This route takes raw() for that reason and is mounted before the
//      global JSON parser. Without this check, anyone who finds the URL can
//      POST a "payment completed" and get free service.
//
//   2. RE-DERIVE THE PLAN FROM THE BASKET'S CUSTOM DATA, NEVER FROM THE
//      REQUEST. What was bought travels in the basket `custom` object set
//      server-side in services/tebexService.ts. It is not something the
//      browser — or whoever is calling this endpoint — can choose.
//
//   3. VERIFY THE AMOUNT AND CURRENCY BEFORE APPLYING. This is Tebex's own
//      warning, worth repeating in the terms that make it obvious: a valid
//      signature proves the message came from Tebex. It does not prove the
//      message says what we intended to sell. If Tebex reports $6.00 paid and
//      recalculating the plan says $60.00, something is wrong — a stale price
//      in the client, a bug in basket construction, a manipulated basket — and
//      the plan must be refused, not applied at the wrong price. Currency is
//      checked too: 60 of the wrong unit is not the price, and an account
//      currency misconfiguration is silent otherwise.
//
//   4. END PLANS THAT END. payment.completed is not the only lifecycle event
//      that matters. A subscription that lapses, is cancelled, or is refunded
//      has to take the plan with it, or a customer stops paying and keeps
//      everything. The previous integration handled only the initial payment,
//      so nothing a customer did afterwards ever reached us.
//
// Mounted at /webhooks/tebex — no session auth, because Tebex is not a
// logged-in dashboard user. Authenticity comes entirely from the signature.

import { Router, raw } from "express";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";
import { applyPlanChange, endPaidPlan } from "../services/billingService.ts";
import { logger } from "../utils/logger.ts";
import {
  calculateFullQuote,
  type RateLimitTier,
  type HostingMode,
  type RateLimitCaps,
} from "../../../shared/schema/pricing.ts";

export const tebexWebhookRouter = Router();

/** The envelope every Tebex webhook arrives in. */
interface TebexWebhook {
  id: string;
  type: string;
  date: string;
  subject: Record<string, unknown>;
}

/**
 * Constant-time comparison of the computed signature against the header.
 *
 * A plain === leaks, through timing, how much of a guessed signature was
 * correct — which turns forging one into a per-character search instead of a
 * search over the whole space.
 */
function signatureMatches(rawBody: Buffer, provided: string): boolean {
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const expected = crypto
    .createHmac("sha256", env.TEBEX_WEBHOOK_SECRET)
    .update(bodyHash)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a signal, so
  // the lengths are compared first and a mismatch is simply a failure.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

tebexWebhookRouter.post("/tebex", raw({ type: "*/*" }), async (req, res) => {
  const provided = req.headers["x-signature"];
  if (!provided || typeof provided !== "string") {
    return res.status(400).send("Missing X-Signature header");
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    // Means the raw() parser above did not run — almost certainly because a
    // global JSON parser was mounted first. Fail loudly; verifying against a
    // re-serialised body would fail every signature and look like a secret
    // mismatch, which is a long way from the actual cause.
    logger.error("Tebex webhook: body is not raw, signature cannot be verified");
    return res.status(500).send("Server misconfigured: raw body unavailable");
  }

  if (!signatureMatches(rawBody, provided)) {
    return res.status(401).send("Invalid signature");
  }

  let event: TebexWebhook;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as TebexWebhook;
  } catch {
    return res.status(400).send("Malformed JSON");
  }

  // Tebex sends this once when the endpoint is first added, and expects the
  // webhook's own id echoed back. Answering anything else leaves the endpoint
  // unvalidated and no other event is ever delivered.
  if (event.type === "validation.webhook") {
    logger.info("Tebex webhook: validation handshake", { id: event.id });
    return res.status(200).json({ id: event.id });
  }

  try {
    switch (event.type) {
      case "payment.completed":
        await handlePaymentCompleted(event);
        break;

      // A subscription that ended, however it ended. Tebex distinguishes a
      // requested cancellation (which takes effect at period end) from the
      // subscription actually ending; only the ending revokes anything, so a
      // customer who cancels keeps what they paid for until it runs out.
      case "recurring-payment.ended":
        await handleRecurringEnded(event);
        break;

      case "payment.refunded":
        await handleRefunded(event);
        break;

      default:
        // Acknowledged and ignored. Tebex retries non-2xx, and retrying an
        // event we deliberately do not act on wastes both sides' time.
        logger.debug("Tebex webhook: ignoring event type", { type: event.type, id: event.id });
    }
  } catch (err) {
    // A 500 asks Tebex to retry, which is what we want for a transient
    // database failure — the alternative is silently dropping a payment.
    logger.error("Tebex webhook: handler threw", {
      type: event.type,
      id: event.id,
      error: String(err),
    });
    return res.status(500).json({ error: "handler_failed" });
  }

  res.json({ received: true });
});

/** Reads our own server-set data back off the webhook subject. */
function readCustom(subject: Record<string, unknown>): Record<string, string> | null {
  const custom = subject.custom;
  if (!custom || typeof custom !== "object") return null;
  return custom as Record<string, string>;
}

/** Tebex reports money as a decimal amount plus a currency, not integer cents. */
function readPrice(subject: Record<string, unknown>): { cents: number; currency: string } | null {
  const price = subject.price as { amount?: unknown; currency?: unknown } | undefined;
  if (!price || typeof price.amount === "undefined") return null;
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return null;
  // Rounded rather than truncated: 59.999999 out of a float round-trip is 6000
  // cents, and flooring it would be 5999 and would refuse a correct payment.
  return { cents: Math.round(amount * 100), currency: String(price.currency ?? "") };
}

async function handlePaymentCompleted(event: TebexWebhook) {
  const subject = event.subject;
  const custom = readCustom(subject);

  if (!custom?.guildId || !custom?.rateLimitTier || !custom?.hostingMode) {
    // Not a basket this service created. Refuse rather than guess — this is
    // the branch that would otherwise hand out plans for unrelated payments.
    logger.error("Tebex webhook: payment has no recognisable plan data, refusing", {
      id: event.id,
    });
    return;
  }

  const plan = {
    rateLimitTier: custom.rateLimitTier as RateLimitTier,
    hostingMode: custom.hostingMode as HostingMode,
    customCaps: custom.customCaps
      ? (JSON.parse(custom.customCaps) as Partial<RateLimitCaps>)
      : undefined,
  };

  const expected = calculateFullQuote(plan);
  if (!expected.valid) {
    logger.error("Tebex webhook: recalculated plan is invalid, refusing", {
      id: event.id,
      guildId: custom.guildId,
    });
    return;
  }

  const paid = readPrice(subject);
  if (!paid) {
    logger.error("Tebex webhook: payment carries no readable price, refusing", { id: event.id });
    return;
  }

  if (paid.currency && paid.currency.toUpperCase() !== "USD") {
    // Every price in shared/schema/pricing.ts is USD cents. A payment settled
    // in another currency cannot be compared against it, and treating the
    // number as dollars would apply a plan for whatever that amount happened
    // to be worth.
    logger.error("Tebex webhook: payment currency is not USD, refusing", {
      id: event.id,
      guildId: custom.guildId,
      currency: paid.currency,
    });
    return;
  }

  if (paid.cents !== expected.totalUsdCentsPerYear) {
    logger.error("Tebex webhook: paid amount does not match the recalculated plan, refusing", {
      id: event.id,
      guildId: custom.guildId,
      paidCents: paid.cents,
      expectedCents: expected.totalUsdCentsPerYear,
    });
    return;
  }

  // Stored so the subscription's later events can be matched back to this
  // guild; they identify themselves by this reference and carry no custom data.
  const reference = subject.recurring_payment_reference;

  const result = await applyPlanChange(
    BigInt(custom.guildId),
    plan,
    typeof reference === "string" && reference.length > 0 ? reference : null,
  );

  logger.info("Tebex webhook: plan change processed", {
    id: event.id,
    guildId: custom.guildId,
    applied: result.applied,
    reason: result.reason,
    // Renewals arrive as another payment.completed against the same
    // subscription, which re-applies the same plan and moves the renewal date
    // forward another year. Logged distinctly so the two are tellable apart.
    renewal: Boolean(reference),
  });
}

async function handleRecurringEnded(event: TebexWebhook) {
  const reference = event.subject.reference ?? event.subject.recurring_payment_reference;
  if (typeof reference !== "string" || !reference) {
    logger.error("Tebex webhook: subscription ended with no reference, cannot match a guild", {
      id: event.id,
    });
    return;
  }

  const guild = await db.query.guilds.findFirst({
    where: eq(schema.guilds.tebexRecurringReference, reference),
  });

  if (!guild) {
    // Not necessarily wrong: a guild downgraded by other means no longer
    // holds a reference, and the subscription ending afterwards is expected.
    logger.warn("Tebex webhook: subscription ended but no guild holds that reference", {
      id: event.id,
    });
    return;
  }

  await endPaidPlan(guild.id, "subscription_ended");
  logger.info("Tebex webhook: paid plan ended, guild returned to the free selection", {
    id: event.id,
    guildId: guild.id.toString(),
  });
}

async function handleRefunded(event: TebexWebhook) {
  const custom = readCustom(event.subject);
  if (!custom?.guildId) {
    logger.warn("Tebex webhook: refund carries no plan data, nothing to revoke", { id: event.id });
    return;
  }

  await endPaidPlan(BigInt(custom.guildId), "refunded");
  logger.info("Tebex webhook: payment refunded, guild returned to the free selection", {
    id: event.id,
    guildId: custom.guildId,
  });
}
