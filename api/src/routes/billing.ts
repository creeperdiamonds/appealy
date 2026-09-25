// api/src/routes/billing.ts
//
// Three concerns, deliberately kept separate:
//   GET /presets, GET / — read-only: reference data and the guild's
//     current resolved plan + price.
//   POST /quote — pure price calculation, no persistence, no payment
//     side-effects. Called on every dashboard slider/input change so the
//     admin always sees the real price before ever reaching checkout.
//     Delegates entirely to shared/schema/pricing.ts so this can never
//     disagree with what the bot enforces or what checkout actually charges.
//   POST /checkout — creates a Paddle checkout for a chosen plan and returns
//     the URL to redirect the admin to. This is the only route that talks to
//     Paddle directly; the actual plan change is applied by applyPlanChange()
//     (services/billingService.ts) ONLY from the webhook handler in
//     routes/paddleWebhook.ts once Paddle confirms payment succeeded — never
//     from this route, and never from client input alone. See
//     routes/paddleWebhook.ts for why.
//
// ALL BILLING HERE IS ANNUAL-ONLY. See the comment at the top of
// shared/schema/pricing.ts for why: standard card-processing fees are
// roughly 2.9% + $0.30 per transaction, and at our price points a monthly
// cadence would hand a large fraction of every payment to the processor
// in flat per-transaction fees. One annual charge instead of twelve
// monthly ones cuts the effective fee rate roughly 3x at these amounts.
//
// Mounted at /api/guilds/:guildId/billing

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { env } from "../env.ts";
import { logger } from "../utils/logger.ts";
import {
  cancelPaddleSubscription,
  createPaddleCheckout,
  paddleReady,
  repointPaddleSubscription,
} from "../services/paddleService.ts";
import { billingWindow } from "../../../shared/schema/billingWindow.ts";
import {
  calculateFullQuote,
  CUSTOM_CAP_MAXIMUMS,
  RATE_LIMIT_PRESETS,
  MINIMUM_CHARGE_CENTS,
  customBotHostingPrice,
  type RateLimitCaps,
} from "../../../shared/schema/pricing.ts";

export const billingRouter = Router({ mergeParams: true });

const customCapsSchema = z.object({
  submissionsPerDay: z.number().int().min(0).optional(),
  ticketsPerDay: z.number().int().min(0).optional(),
  giveawayEntriesPerDay: z.number().int().min(0).optional(),
  apiRequestsPerMinute: z.number().int().min(0).optional(),
  formsPerGuild: z.number().int().min(0).optional(),
  panelsPerGuild: z.number().int().min(0).optional(),
  rolesPerRuleType: z.number().int().min(0).optional(),
  historyRetentionDays: z.number().int().min(0).optional(),
});

const quoteSchema = z.object({
  rateLimitTier: z.enum(["free", "tier1", "tier2", "custom"]),
  customCaps: customCapsSchema.optional(),
  hostingMode: z.enum(["shared", "custom"]),
});

billingRouter.use(requireGuildAccess);

// Reference data for the dashboard to render preset cards and the custom
// cap form's min/max bounds without hardcoding numbers client-side.
billingRouter.get("/presets", async (_req, res) => {
  res.json({
    presets: RATE_LIMIT_PRESETS,
    customCapMaximums: CUSTOM_CAP_MAXIMUMS,
    customBotHosting: customBotHostingPrice(),
    minimumChargeUsdCents: MINIMUM_CHARGE_CENTS,
  });
});

billingRouter.get("/", async (req, res) => {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, BigInt(routeParams(req).guildId)) });
  if (!guild) return res.status(404).json({ error: "guild_not_found" });

  const quote = calculateFullQuote({
    rateLimitTier: guild.rateLimitTier,
    customCaps: (guild.customRateLimits as Partial<RateLimitCaps>) ?? undefined,
    hostingMode: guild.hostingMode,
  });

  res.json({
    current: quote,
    customBillingRenewsAt: guild.customBillingRenewsAt?.toISOString() ?? null,
  });
});

// Pure quote — safe to call as often as the UI needs, never persists
// anything and never talks to Paddle. This is what makes "see the price
// before checkout" possible: the dashboard calls this on every change to
// the throughput/hosting selection and renders the response directly.
billingRouter.post("/quote", async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });

  const quote = calculateFullQuote(parsed.data);
  res.json(quote);
});

// Creates a Paddle checkout for the requested plan and returns the URL to send
// the admin to. Does NOT change the guild's plan — that only happens once
// Paddle's webhook confirms the payment actually succeeded
// (routes/paddleWebhook.ts). The requested plan travels as custom_data so the
// webhook can recover exactly what was bought without trusting anything its
// caller sends — see the warning in that file.
billingRouter.post("/checkout", requireAdminAccess, async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;

  const quote = calculateFullQuote(data);
  if (!quote.valid) {
    return res.status(400).json({
      error: "invalid_custom_caps",
      detail: "One or more requested caps exceed the maximum allowed.",
      errors: quote.errors,
    });
  }
  if (quote.totalUsdCentsPerYear === 0) {
    return res.status(400).json({
      error: "nothing_to_charge",
      detail: "This selection is free — no checkout is needed. Use PUT /billing/downgrade-to-free instead.",
    });
  }
  if (quote.belowMinimumCharge) {
    return res.status(400).json({
      error: "below_minimum_charge",
      detail: `This selection totals less than the $${(MINIMUM_CHARGE_CENTS / 100).toFixed(2)} minimum charge. Increase your custom caps or choose a preset tier.`,
      minimumChargeUsdCents: MINIMUM_CHARGE_CENTS,
      quotedUsdCents: quote.totalUsdCentsPerYear,
    });
  }

  try {
    const checkoutArgs = {
      guildId: routeParams(req).guildId,
      userId: req.userId!.toString(),
      plan: data,
      quote,
    };
    // Paddle is the only provider. There is nothing to fall back to, so the
    // two failure modes have to be told apart rather than both becoming
    // "checkout broke":
    //
    //   not ready   a configuration problem on our side — a missing or
    //               mismatched key. The buyer can do nothing about it and
    //               should be told that plainly, not shown a stack trace.
    //   threw       Paddle was asked and refused. Loud, because it means
    //               sales are stopping and nothing else will catch them.
    //
    // Both return 503, not 502: the request was fine, the service behind it
    // is temporarily unable to sell.
    //
    // paddleReady() exists because the switch used to be "is PADDLE_API_KEY
    // set", which broke checkout the day the key was added: a key exists long
    // before the account behind it can sell, which needs an approved checkout
    // domain and a verified identity first. It rules out a missing or
    // mismatched key without spending a request; everything else — domain not
    // approved, account not verified, suspended — only Paddle knows, and a
    // refusal from them IS the check.
    const readiness = paddleReady();
    if (!readiness.ready) {
      logger.error("Checkout attempted while Paddle is not configured", {
        guildId: routeParams(req).guildId,
        reason: readiness.reason,
      });
      return res.status(503).json({
        error: "payments_unavailable",
        detail: "Payments are temporarily unavailable. Nothing was charged — please try again later.",
      });
    }

    const checkout = await createPaddleCheckout(checkoutArgs);
    res.json({ checkoutUrl: checkout.checkoutUrl });
  } catch (err) {
    logger.error("Paddle checkout failed", {
      guildId: routeParams(req).guildId,
      error: String(err),
    });
    res.status(503).json({
      error: "payments_unavailable",
      detail: "Payments are temporarily unavailable. Nothing was charged — please try again later.",
    });
  }
});

// Dropping to the fully-free selection. Allowed ONLY inside the 14-day refund
// window, because that is the only time the money can come back.
//
// Before today this route cleared the plan and stopped there. Nothing in the
// API cancelled a Paddle subscription — so "downgrade" meant losing the plan
// immediately while the subscription kept billing every year, indefinitely,
// against a guild already on free. The UI even said "that time is not
// refunded", which understated it: you also kept paying for the next year.
//
// Past the window the answer is cancel-renewal below, not this. Throwing away
// a year that is already bought and unrefundable helps nobody.
billingRouter.put("/downgrade-to-free", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  if (!guild) return res.status(404).json({ error: "guild_not_found" });

  const window = billingWindow(guild.customBillingRenewsAt);
  if (window.paid && !window.refundable) {
    return res.status(409).json({
      error: "refund_window_closed",
      detail:
        "This plan is past its 14-day refund window, so dropping to free would throw away a year " +
        "that is already paid for. Cancel the renewal instead — you keep the plan until it expires " +
        "and it will not bill again.",
      refundableUntil: window.refundableUntil?.toISOString() ?? null,
    });
  }

  // Stop the money first. If this throws, nothing in our database has changed
  // and the plan is still the one being paid for — which is the honest state.
  // Doing it the other way round can leave a free guild with a live
  // subscription, which is the bug this route used to have permanently.
  if (guild.paddleSubscriptionId) {
    try {
      await cancelPaddleSubscription(guild.paddleSubscriptionId, "immediately");
    } catch (err) {
      logger.error("Downgrade refused: could not cancel the subscription", {
        guildId: routeParams(req).guildId,
        error: String(err),
      });
      return res.status(502).json({
        error: "cancel_failed",
        detail: "Could not stop the subscription, so nothing was changed. Try again shortly.",
      });
    }
  }

  const [updated] = await db
    .update(schema.guilds)
    .set({
      rateLimitTier: "free",
      customRateLimits: null,
      hostingMode: "shared",
      customBillingRenewsAt: null,
      // Cleared with the plan: a stale id here would let a later webhook for
      // this dead subscription match a guild that no longer holds it.
      paddleSubscriptionId: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.guilds.id, guildId))
    .returning();

  logger.info("Downgraded to free inside the refund window", {
    guildId: routeParams(req).guildId,
    hadSubscription: Boolean(guild.paddleSubscriptionId),
  });

  res.json({
    quote: calculateFullQuote({ rateLimitTier: "free", hostingMode: "shared" }),
    customBillingRenewsAt: updated.customBillingRenewsAt,
  });
});

// Stops the next charge while keeping what was already bought.
//
// This is what people actually mean by "cancel" once the refund window has
// closed, and without it there is no way to stop recurring billing at all —
// the plan would renew every year until the card died.
// Get a plan onto another server.
//
// Mounted on the DESTINATION, not the source, and that is the whole point. If
// a server is deleted, Discord stops listing it, so requireGuildAccess denies
// the person the very screen that would let them move or stop the plan — the
// money is stranded behind a permission check on a thing that no longer
// exists. Asking from the server you still have is the only route that
// survives that.
//
// The source is authorised either by admin access to it, or by being the
// owner recorded on the row. The second is what covers the deleted case: the
// guild is gone, nobody can hold a live permission on it, and guilds.owner_id
// is the last remaining evidence that the plan was yours.
billingRouter.post("/transfer-in", requireAdminAccess, async (req, res) => {
  const toGuildId = BigInt(routeParams(req).guildId);
  const parsed = z.object({ fromGuildId: z.string().regex(/^\d{17,20}$/) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const fromGuildId = BigInt(parsed.data.fromGuildId);
  if (fromGuildId === toGuildId) {
    return res.status(400).json({ error: "same_guild", detail: "That is the same server." });
  }

  const [from, to] = await Promise.all([
    db.query.guilds.findFirst({ where: eq(schema.guilds.id, fromGuildId) }),
    db.query.guilds.findFirst({ where: eq(schema.guilds.id, toGuildId) }),
  ]);
  if (!from) return res.status(404).json({ error: "source_not_found" });
  if (!to) return res.status(404).json({ error: "guild_not_found" });

  // Ownership of the SOURCE is the only rule, and it has to be, because
  // req.guildAccessLevel describes the destination — this route is mounted
  // there. Checking it against the source would be reading one server's
  // permission and calling it another's.
  //
  // A live permission lookup on the source is not the answer either: in the
  // case this exists for, the source is deleted, so no permission can exist
  // and every lookup would deny. guilds.owner_id outlives the guild, which is
  // exactly why it is the evidence used.
  //
  // The cost, stated: an admin who is not the owner cannot move a plan, even
  // between two live servers they run. That matches export/import, which is
  // owner-only for the same reason — this moves money, not configuration.
  if (from.ownerId !== req.userId) {
    return res.status(403).json({
      error: "not_entitled",
      detail:
        "Only the owner of the server the plan is on can move it. Sign in with that account, " +
        "or ask them to.",
    });
  }

  const fromQuote = calculateFullQuote({
    rateLimitTier: from.rateLimitTier,
    customCaps: (from.customRateLimits as Partial<RateLimitCaps>) ?? undefined,
    hostingMode: from.hostingMode,
  });
  if (fromQuote.totalUsdCentsPerYear === 0) {
    return res.status(409).json({
      error: "nothing_to_transfer",
      detail: "That server is on the free selection, so there is no plan to move.",
    });
  }

  // Refused rather than merged. There is one paddle_subscription_id per guild,
  // so two plans on one server means one subscription this database can no
  // longer name — it keeps billing with nothing pointing at it, which is the
  // exact failure this feature exists to prevent.
  const toQuote = calculateFullQuote({
    rateLimitTier: to.rateLimitTier,
    customCaps: (to.customRateLimits as Partial<RateLimitCaps>) ?? undefined,
    hostingMode: to.hostingMode,
  });
  if (toQuote.totalUsdCentsPerYear > 0) {
    return res.status(409).json({
      error: "destination_already_paid",
      detail:
        "This server already has a paid plan. Drop it to free first, then move the other one in.",
    });
  }

  // Hosting does not travel. customBotTokenEnc is the OTHER server's own bot
  // token, and that application is invited to that server — a row pointer
  // cannot invite it here. The throughput tier and the year already paid for
  // move; the destination lands on shared hosting and adds its own bot if it
  // wants one, which is honest, because it would be a different bot.
  const hostingMoved = from.hostingMode === "custom";

  await db.transaction(async (tx) => {
    await tx
      .update(schema.guilds)
      .set({
        rateLimitTier: from.rateLimitTier,
        customRateLimits: from.customRateLimits,
        hostingMode: "shared",
        customBillingRenewsAt: from.customBillingRenewsAt,
        paddleSubscriptionId: from.paddleSubscriptionId,
        updatedAt: new Date(),
      })
      .where(eq(schema.guilds.id, toGuildId));

    await tx
      .update(schema.guilds)
      .set({
        rateLimitTier: "free",
        customRateLimits: null,
        hostingMode: "shared",
        customBillingRenewsAt: null,
        paddleSubscriptionId: null,
        // Same teardown as DELETE /dedicated-bot: the plan that paid for the
        // dedicated instance has gone, so the instance goes with it.
        customBotTokenEnc: null,
        customBotStatus: "stopped",
        customBotError: null,
        customBotRunnerId: null,
        customBotHeartbeatAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.guilds.id, fromGuildId));
  });

  // Best effort, and after the database rather than before it. The webhook
  // finds a guild by paddle_subscription_id, which has already moved, so
  // renewals land correctly even if this call fails; custom_data is what a
  // human reads in Paddle's own dashboard.
  if (from.paddleSubscriptionId) {
    try {
      await repointPaddleSubscription(from.paddleSubscriptionId, toGuildId.toString());
    } catch (err) {
      logger.warn("Plan moved, but Paddle's own record still names the old server", {
        subscriptionId: from.paddleSubscriptionId,
        fromGuildId: fromGuildId.toString(),
        toGuildId: toGuildId.toString(),
        error: String(err),
      });
    }
  }

  logger.info("Plan moved to another server", {
    fromGuildId: fromGuildId.toString(),
    toGuildId: toGuildId.toString(),
    hostingLeftBehind: hostingMoved,
  });

  res.json({
    moved: true,
    hostingLeftBehind: hostingMoved,
    quote: calculateFullQuote({
      rateLimitTier: from.rateLimitTier,
      customCaps: (from.customRateLimits as Partial<RateLimitCaps>) ?? undefined,
      hostingMode: "shared",
    }),
    customBillingRenewsAt: from.customBillingRenewsAt?.toISOString() ?? null,
  });
});

billingRouter.put("/cancel-renewal", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  if (!guild) return res.status(404).json({ error: "guild_not_found" });
  if (!guild.paddleSubscriptionId) {
    return res.status(409).json({
      error: "no_subscription",
      detail: "This server has no recurring payment to stop.",
    });
  }

  try {
    await cancelPaddleSubscription(guild.paddleSubscriptionId, "next_billing_period");
  } catch (err) {
    logger.error("Could not cancel the renewal", {
      guildId: routeParams(req).guildId,
      error: String(err),
    });
    return res.status(502).json({
      error: "cancel_failed",
      detail: "Could not stop the renewal, so nothing was changed. Try again shortly.",
    });
  }

  // The plan itself is deliberately untouched. It runs to customBillingRenewsAt
  // and the SubscriptionCanceled webhook returns the guild to free when Paddle
  // says the period has actually ended — which keeps one place deciding when a
  // plan stops.
  logger.info("Renewal cancelled; plan runs to its end", {
    guildId: routeParams(req).guildId,
    until: guild.customBillingRenewsAt?.toISOString() ?? null,
  });

  res.json({
    cancelled: true,
    paidUntil: guild.customBillingRenewsAt?.toISOString() ?? null,
  });
});
