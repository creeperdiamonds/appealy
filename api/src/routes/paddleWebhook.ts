// api/src/routes/paddleWebhook.ts
//
// Receives Paddle's notifications and is the ONLY place a paid plan change is
// applied on the Paddle side (via services/billingService.ts). It is a port of
// routes/tebexWebhook.ts and keeps its four rules, because none of them were
// about Tebex specifically:
//
//   1. VERIFY THE SIGNATURE, OVER THE RAW BYTES. Paddle signs every webhook
//      with the secret of the notification destination it was sent to. The
//      header is `Paddle-Signature: ts=<unix>;h1=<hex>` and the signed string
//      is `<ts>:<raw body>`, HMAC-SHA256. paddle.webhooks.unmarshal() does all
//      of that, but only if it is handed the bytes Paddle sent: this route
//      takes raw() and is mounted before the global JSON parser, because
//      express.json() re-serialises and a re-serialised body does not match.
//      Without this check, anyone who finds the URL can POST a "payment
//      completed" and get free service.
//
//   2. RE-DERIVE THE PLAN FROM OUR OWN DATA, NEVER FROM THE REQUEST. What was
//      bought travels in the transaction's custom_data, set server-side in
//      services/paddleService.ts. Paddle copies it onto the subscription too.
//
//   3. VERIFY THE AMOUNT AND CURRENCY BEFORE APPLYING. A valid signature
//      proves the message came from Paddle. It does not prove the message says
//      what we intended to sell. The comparison is against details.totals
//      .subtotal — the pre-tax figure — because every price in
//      shared/schema/pricing.ts is tax-exclusive and Paddle, as merchant of
//      record, adds VAT or sales tax on top. Comparing the tax-inclusive
//      grandTotal would refuse every correct payment from a taxed country.
//
//   4. END PLANS THAT END. A subscription that is cancelled or lapses has to
//      take the plan with it, or a customer stops paying and keeps everything.
//
// RETRIES. Paddle treats only a 2xx as delivered and retries anything else —
// 60 times over ~3 days in live. So a failure here must NOT answer 2xx: a
// transient database error should be retried, and the one status that loses a
// payment forever is a 200 on a request we failed to handle.
//
// Mounted at /webhooks/paddle — no session auth, because Paddle is not a
// logged-in dashboard user. Authenticity comes entirely from the signature.

import { Router, raw } from "express";
import { EventName, Paddle, Environment, LogLevel } from "@paddle/paddle-node-sdk";
import type {
  AdjustmentCreatedEvent,
  AdjustmentUpdatedEvent,
  EventEntity,
  SubscriptionCanceledEvent,
  TransactionCompletedEvent,
} from "@paddle/paddle-node-sdk";
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

export const paddleWebhookRouter = Router();

let client: Paddle | null = null;

function paddle(): Paddle {
  if (client) return client;
  client = new Paddle(env.PADDLE_API_KEY, {
    environment: env.PADDLE_ENV === "production" ? Environment.production : Environment.sandbox,
    logLevel: LogLevel.error,
  });
  return client;
}

paddleWebhookRouter.post("/paddle", raw({ type: "*/*" }), async (req, res) => {
  if (!env.PADDLE_WEBHOOK_SECRET) {
    // Paddle is not configured yet (Tebex is still the live integration).
    // 503 rather than 200: an unconfigured endpoint should not swallow events.
    logger.error("Paddle webhook: PADDLE_WEBHOOK_SECRET is unset, cannot verify");
    return res.status(503).send("Paddle webhooks are not configured");
  }

  const signature = req.headers["paddle-signature"];
  if (!signature || typeof signature !== "string") {
    return res.status(400).send("Missing Paddle-Signature header");
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    // The raw() parser above did not run — almost certainly a global JSON
    // parser mounted first. Fail loudly: verifying a re-serialised body fails
    // every signature and looks exactly like a wrong secret, which is a long
    // way from the actual cause.
    logger.error("Paddle webhook: body is not raw, signature cannot be verified");
    return res.status(500).send("Server misconfigured: raw body unavailable");
  }

  let event: EventEntity;
  try {
    // Throws on a bad signature, an expired timestamp, or a malformed payload.
    // Those are indistinguishable from each other here, so they share one
    // answer — and it is a non-2xx, so a rotated secret recovers on retry once
    // the new one is deployed.
    event = await paddle().webhooks.unmarshal(rawBody.toString("utf8"), env.PADDLE_WEBHOOK_SECRET, signature);
  } catch (err) {
    logger.error("Paddle webhook: signature verification failed", { error: String(err) });
    return res.status(401).send("Invalid signature");
  }

  try {
    switch (event.eventType) {
      case EventName.TransactionCompleted:
        await handleTransactionCompleted(event as TransactionCompletedEvent);
        break;

      // The subscription is over: cancelled and past its period, or ended by
      // Paddle. Note that a customer *requesting* cancellation arrives as
      // subscription.updated with a scheduled change, and does not revoke
      // anything — they keep what they paid for until it actually runs out.
      case EventName.SubscriptionCanceled:
        await handleSubscriptionCanceled(event as SubscriptionCanceledEvent);
        break;

      // A refund or a chargeback takes the plan with it. Both arrive as
      // adjustments; "created" is often still pending approval, so the status
      // is what decides, not the event name.
      case EventName.AdjustmentCreated:
      case EventName.AdjustmentUpdated:
        await handleAdjustment(event as AdjustmentCreatedEvent | AdjustmentUpdatedEvent);
        break;

      default:
        // Acknowledged and ignored. Paddle retries non-2xx, and retrying an
        // event we deliberately do not act on wastes both sides' time.
        logger.debug("Paddle webhook: ignoring event type", {
          type: event.eventType,
          id: event.eventId,
        });
    }
  } catch (err) {
    // Non-2xx asks Paddle to retry, which is what a transient database failure
    // needs. The alternative is silently dropping a payment.
    logger.error("Paddle webhook: handler threw", {
      type: event.eventType,
      id: event.eventId,
      error: String(err),
    });
    return res.status(500).json({ error: "handler_failed" });
  }

  res.json({ received: true });
});

/** Our own server-set data, as it comes back off a webhook. */
function readCustom(data: { customData?: unknown }): Record<string, string> | null {
  const custom = data.customData;
  if (!custom || typeof custom !== "object") return null;
  return custom as Record<string, string>;
}

async function handleTransactionCompleted(event: TransactionCompletedEvent) {
  const data = event.data;
  const custom = readCustom(data);

  if (!custom?.guildId || !custom?.rateLimitTier || !custom?.hostingMode) {
    // Not a transaction this service created. Refuse rather than guess — this
    // is the branch that would otherwise hand out plans for unrelated payments.
    logger.error("Paddle webhook: payment has no recognisable plan data, refusing", {
      id: event.eventId,
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
    logger.error("Paddle webhook: recalculated plan is invalid, refusing", {
      id: event.eventId,
      guildId: custom.guildId,
    });
    return;
  }

  const totals = data.details?.totals;
  if (!totals) {
    logger.error("Paddle webhook: payment carries no totals, refusing", { id: event.eventId });
    return;
  }

  if (totals.currencyCode !== "USD") {
    // Every price in shared/schema/pricing.ts is USD cents. A payment settled
    // in another currency cannot be compared against it, and treating the
    // number as dollars would apply a plan for whatever that amount was worth.
    logger.error("Paddle webhook: payment currency is not USD, refusing", {
      id: event.eventId,
      guildId: custom.guildId,
      currency: totals.currencyCode,
    });
    return;
  }

  // Paddle reports money as a string of minor units, so this is already cents.
  // subtotal, not grandTotal: our prices are tax-exclusive and Paddle adds the
  // tax it owes as merchant of record on top.
  const paidCents = Number(totals.subtotal);
  if (!Number.isInteger(paidCents) || paidCents <= 0) {
    logger.error("Paddle webhook: payment has no readable amount, refusing", {
      id: event.eventId,
      subtotal: totals.subtotal,
    });
    return;
  }

  // A renewal bills the price quoted when the plan was bought, which stops
  // matching a recalculation the moment pricing.ts changes — and would then
  // refuse every existing subscription's renewal. quotedCents is written
  // server-side into custom_data and the signature proves Paddle returned it
  // unmodified, so a payment equal to it is exactly the price we quoted.
  const quotedCents = Number(custom.quotedCents);
  const matchesQuote = Number.isInteger(quotedCents) && quotedCents > 0 && paidCents === quotedCents;

  if (paidCents !== expected.totalUsdCentsPerYear && !matchesQuote) {
    logger.error(
      "Paddle webhook: paid amount matches neither the recalculated plan nor its checkout quote, refusing",
      {
        id: event.eventId,
        guildId: custom.guildId,
        paidCents,
        expectedCents: expected.totalUsdCentsPerYear,
        quotedCents: Number.isFinite(quotedCents) ? quotedCents : null,
      },
    );
    return;
  }

  if (paidCents !== expected.totalUsdCentsPerYear) {
    logger.warn(
      "Paddle webhook: honouring the price quoted at checkout, which differs from current pricing",
      {
        id: event.eventId,
        guildId: custom.guildId,
        paidCents,
        expectedCents: expected.totalUsdCentsPerYear,
      },
    );
  }

  // Stored so the subscription's later events can be matched back to this
  // guild; they identify themselves by this id and carry no custom data of
  // their own once the subscription is the subject.
  const subscriptionId = data.subscriptionId ?? null;

  // Idempotent by construction: Paddle re-sends the same event on every retry,
  // and applying the same plan twice sets the same columns to the same values.
  const result = await applyPlanChange(BigInt(custom.guildId), plan, subscriptionId);

  logger.info("Paddle webhook: plan change processed", {
    id: event.eventId,
    guildId: custom.guildId,
    applied: result.applied,
    reason: result.reason,
    // Renewals arrive as another transaction.completed against the same
    // subscription, re-applying the plan and moving the renewal date forward.
    renewal: Boolean(subscriptionId),
  });
}

async function handleSubscriptionCanceled(event: SubscriptionCanceledEvent) {
  const subscriptionId = event.data.id;
  if (!subscriptionId) {
    logger.error("Paddle webhook: subscription ended with no id, cannot match a guild", {
      id: event.eventId,
    });
    return;
  }

  const guild = await db.query.guilds.findFirst({
    where: eq(schema.guilds.paddleSubscriptionId, subscriptionId),
  });

  if (!guild) {
    // Not necessarily wrong: a guild downgraded by other means no longer holds
    // a subscription id, and the subscription ending afterwards is expected.
    logger.warn("Paddle webhook: subscription ended but no guild holds that id", {
      id: event.eventId,
    });
    return;
  }

  await endPaidPlan(guild.id, "subscription_ended");
  logger.info("Paddle webhook: paid plan ended, guild returned to the free selection", {
    id: event.eventId,
    guildId: guild.id.toString(),
  });
}

async function handleAdjustment(event: AdjustmentCreatedEvent | AdjustmentUpdatedEvent) {
  const adjustment = event.data;

  // Credits and chargeback warnings do not take money back; reversals give it
  // back to us. Only an actual refund or chargeback ends the plan.
  if (adjustment.action !== "refund" && adjustment.action !== "chargeback") {
    logger.debug("Paddle webhook: adjustment is not a refund or chargeback, ignoring", {
      id: event.eventId,
      action: adjustment.action,
    });
    return;
  }

  // A refund that has not been approved has not happened yet. Revoking on a
  // pending one would punish a customer whose refund is later rejected.
  if (adjustment.status !== "approved") {
    logger.debug("Paddle webhook: adjustment not approved yet, ignoring", {
      id: event.eventId,
      status: adjustment.status,
    });
    return;
  }

  const subscriptionId = adjustment.subscriptionId;
  if (!subscriptionId) {
    // A one-off charge refunded, or an adjustment against something that is
    // not a subscription: nothing here maps to a guild's plan.
    logger.warn("Paddle webhook: refund carries no subscription id, nothing to revoke", {
      id: event.eventId,
      transactionId: adjustment.transactionId,
    });
    return;
  }

  const guild = await db.query.guilds.findFirst({
    where: eq(schema.guilds.paddleSubscriptionId, subscriptionId),
  });

  if (!guild) {
    logger.warn("Paddle webhook: refund but no guild holds that subscription id", {
      id: event.eventId,
    });
    return;
  }

  await endPaidPlan(guild.id, "refunded");
  logger.info("Paddle webhook: payment refunded, guild returned to the free selection", {
    id: event.eventId,
    guildId: guild.id.toString(),
    action: adjustment.action,
  });
}
