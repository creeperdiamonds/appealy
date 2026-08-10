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
//   POST /checkout — creates a Stripe Checkout Session for a chosen plan
//     and returns the URL to redirect the admin to. This is the only route
//     that talks to Stripe directly; the actual plan change is applied by
//     applyPlanChange() (services/billingService.ts) ONLY from the
//     webhook handler in routes/stripeWebhook.ts once Stripe confirms
//     payment succeeded — never from this route, and never from client
//     input alone. See routes/stripeWebhook.ts for why.
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
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { createCheckoutSession } from "../services/stripeService.ts";
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
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, BigInt(req.params.guildId)) });
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
// anything and never talks to Stripe. This is what makes "see the price
// before checkout" possible: the dashboard calls this on every change to
// the throughput/hosting selection and renders the response directly.
billingRouter.post("/quote", async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });

  const quote = calculateFullQuote(parsed.data);
  res.json(quote);
});

// Creates a Stripe Checkout Session for the requested plan and returns the
// URL to send the admin to. Does NOT change the guild's plan — that only
// happens once Stripe's webhook confirms the payment actually succeeded
// (routes/stripeWebhook.ts). The requested plan is embedded in the
// session's metadata so the webhook handler can recover exactly what was
// being purchased without trusting anything the client sends at
// webhook-time — see the warning in that file about why.
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
    const session = await createCheckoutSession({
      guildId: req.params.guildId,
      userId: req.userId!.toString(),
      plan: data,
      quote,
    });
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    res.status(502).json({ error: "checkout_creation_failed", detail: String(err) });
  }
});

// Downgrading to the fully-free selection (free throughput + shared
// hosting) never needs payment confirmation, so it's the one plan change
// applied directly from this route rather than through checkout+webhook.
// Any selection with a nonzero price must go through POST /checkout.
billingRouter.put("/downgrade-to-free", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const [updated] = await db
    .update(schema.guilds)
    .set({
      rateLimitTier: "free",
      customRateLimits: null,
      hostingMode: "shared",
      customBillingRenewsAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.guilds.id, guildId))
    .returning();

  res.json({
    quote: calculateFullQuote({ rateLimitTier: "free", hostingMode: "shared" }),
    customBillingRenewsAt: updated.customBillingRenewsAt,
  });
});
