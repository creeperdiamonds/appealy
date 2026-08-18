// shared/schema/pricing.ts
//
// Pure, deterministic pricing calculator for both billing axes:
//   Axis A — Throughput (rate-limit tier: free / tier1 / tier2 / custom)
//   Axis B — Hosting (shared multi-tenant bot vs. a dedicated hosted
//            instance of your own open-source bot)
//
// No side effects, no DB/network calls — this is intentionally the same
// "pure calculator" pattern as gating.ts, so both the dashboard (for live
// pre-checkout quoting as the admin adjusts sliders) and the API (for the
// authoritative charge amount) call the exact same function and can never
// disagree about a price.
//
// BILLING IS ANNUAL-ONLY FOR EVERY PAID OPTION. This is not a pricing
// preference, it's a fee-survival requirement: standard card processing
// runs roughly 2.9% + $0.30 per transaction, and that flat $0.30 component
// devastates small, frequent charges. Twelve $5/mo charges cost ~9% of
// revenue in fees combined; one $60/year charge for the same total costs
// ~3%. At our price points (several dollars to ~$15/mo equivalent),
// monthly billing would hand a meaningful chunk of every paid plan
// straight to the payment processor for no benefit to us or the customer.
// So: no monthly billing option exists anywhere in this module, on
// purpose, and every displayed price shows both the annual charge and a
// computed (never hardcoded) monthly-equivalent for comparison shopping.
//
// ALL MONEY VALUES ARE INTEGER CENTS. Never floats. Floating-point cents
// arithmetic accumulates rounding error across many transactions in ways
// that are individually invisible and collectively a real bug; integer
// cents with explicit rounding at defined points avoids that class of
// error entirely.
//
// IMPORTANT: every cap has a hard ceiling, including "custom" — there is
// no unlimited tier anywhere in this system. An unbounded cap removes the
// ability to reason about worst-case cost and makes abuse free to attempt,
// so CUSTOM_CAP_MAXIMUMS below is enforced both here (price calculation
// refuses to price above it) and wherever custom caps are persisted.

export type RateLimitTier = "free" | "tier1" | "tier2" | "custom";
export type HostingMode = "shared" | "custom";

export interface RateLimitCaps {
  submissionsPerDay: number;
  ticketsPerDay: number;
  giveawayEntriesPerDay: number;
  apiRequestsPerMinute: number;
  formsPerGuild: number;
  panelsPerGuild: number;
  rolesPerRuleType: number;
  historyRetentionDays: number;
}

// ---------------------------------------------------------------------------
// Preset tiers — data, not logic, so tuning a number never requires a code
// change beyond this table. Prices are annual, in integer cents.
// ---------------------------------------------------------------------------

export const RATE_LIMIT_PRESETS: Record<Exclude<RateLimitTier, "custom">, {
  caps: RateLimitCaps;
  priceUsdCentsPerYear: number;
}> = {
  free: {
    caps: {
      submissionsPerDay: 100,
      ticketsPerDay: 50,
      giveawayEntriesPerDay: 500,
      apiRequestsPerMinute: 60,
      formsPerGuild: 5,
      panelsPerGuild: 5,
      rolesPerRuleType: 3,
      historyRetentionDays: 30,
    },
    priceUsdCentsPerYear: 0,
  },
  tier1: {
    caps: {
      submissionsPerDay: 500,
      ticketsPerDay: 250,
      giveawayEntriesPerDay: 2_500,
      apiRequestsPerMinute: 180,
      formsPerGuild: 50,
      panelsPerGuild: 50,
      rolesPerRuleType: 15,
      historyRetentionDays: 365,
    },
    // $5/mo equivalent, billed annually as a single $60 charge — see the
    // module-level comment on why there is no monthly option.
    priceUsdCentsPerYear: 6_000,
  },
  tier2: {
    caps: {
      submissionsPerDay: 2_000,
      ticketsPerDay: 1_000,
      giveawayEntriesPerDay: 10_000,
      apiRequestsPerMinute: 600,
      formsPerGuild: 100,
      panelsPerGuild: 100,
      rolesPerRuleType: 25,
      historyRetentionDays: 730,
    },
    // $15/mo equivalent, billed annually as a single $180 charge.
    priceUsdCentsPerYear: 18_000,
  },
};

// Hard ceiling for self-service custom caps. No field may be priced or
// persisted above these values under any circumstances — this is the
// deliberate "no unlimited" backstop, not just a UI suggestion.
export const CUSTOM_CAP_MAXIMUMS: RateLimitCaps = {
  submissionsPerDay: 10_000,
  ticketsPerDay: 5_000,
  giveawayEntriesPerDay: 50_000,
  apiRequestsPerMinute: 2_000,
  formsPerGuild: 300,
  panelsPerGuild: 300,
  rolesPerRuleType: 100,
  historyRetentionDays: 1_825, // 5 years
};

// Per-unit ANNUAL price (integer cents) for each unit above the free
// baseline, applied only when rateLimitTier === "custom". These are simply
// the old monthly per-unit cents figures x12 — the underlying "cost per
// unit of throughput" didn't change, only the billing cadence — so a live
// quote is still simple arithmetic the dashboard can recompute on every
// keystroke/slider move without a server round-trip.
//
// giveawayEntriesPerDay is intentionally absent from this table: at the
// original $0.002/mo rate, x12 is 2.4 cents — not a whole number of cents,
// and every constant in this module must be an integer. It's priced
// separately below, per 10 units, at a whole-cent rate instead.
const CUSTOM_CAP_UNIT_PRICE_CENTS_PER_YEAR: Record<
  Exclude<keyof RateLimitCaps, "giveawayEntriesPerDay">,
  number
> = {
  submissionsPerDay: 12, // $0.01/mo equivalent -> $0.12/yr
  ticketsPerDay: 12,
  apiRequestsPerMinute: 60, // $0.05/mo -> $0.60/yr
  formsPerGuild: 12, // $1/mo -> $12/yr flat, not per-day
  panelsPerGuild: 12,
  rolesPerRuleType: 6, // $0.50/mo -> $6/yr
  historyRetentionDays: 24, // $0.02/mo per extra day -> $0.24/yr
};

const GIVEAWAY_ENTRIES_PRICE_CENTS_PER_10_PER_YEAR = 24; // 24 cents per 10 entries/day

const FREE_BASELINE = RATE_LIMIT_PRESETS.free.caps;

// Below this, a standalone charge is not fired — see minimum-charge notes
// on quoteCustomCaps and calculateFullQuote. Small deltas are still shown
// in the quote UI so the admin can see what they'd owe, they just aren't
// charged on their own; a real billing implementation should roll a
// sub-minimum amount into the next cycle's charge rather than skip billing
// for it entirely.
export const MINIMUM_CHARGE_CENTS = 500; // $5.00

// ---------------------------------------------------------------------------
// Custom bot hosting — flat annual fee, unrelated to throughput.
// ---------------------------------------------------------------------------

export const CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR = 1_000; // $10.00/year

export interface AnnualPrice {
  annualUsdCents: number;
  /** Computed, never hardcoded, so it can never drift from the real annual
   * price. Floored to the cent — never round a customer-facing price up. */
  monthlyEquivalentUsdCents: number;
}

export function customBotHostingPrice(): AnnualPrice {
  return {
    annualUsdCents: CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR,
    monthlyEquivalentUsdCents: Math.floor(CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR / 12),
  };
}

function toAnnualPrice(annualUsdCents: number): AnnualPrice {
  return {
    annualUsdCents,
    monthlyEquivalentUsdCents: Math.floor(annualUsdCents / 12),
  };
}

// ---------------------------------------------------------------------------
// Custom cap pricing
// ---------------------------------------------------------------------------

export interface CustomCapQuoteLine {
  cap: keyof RateLimitCaps;
  requested: number;
  freeBaseline: number;
  maximum: number;
  unitsAboveBaseline: number;
  lineTotalUsdCents: number;
}

export interface CustomCapQuote {
  valid: boolean;
  /** Populated only when valid is false — which fields exceeded their max. */
  errors: { cap: keyof RateLimitCaps; requested: number; maximum: number }[];
  lines: CustomCapQuoteLine[];
  totalUsdCentsPerYear: number;
}

function priceCapLine(cap: keyof RateLimitCaps, unitsAboveBaseline: number): number {
  if (cap === "giveawayEntriesPerDay") {
    // Priced per 10 units to keep the per-unit constant a whole cent.
    return Math.round((unitsAboveBaseline / 10) * GIVEAWAY_ENTRIES_PRICE_CENTS_PER_10_PER_YEAR);
  }
  return unitsAboveBaseline * CUSTOM_CAP_UNIT_PRICE_CENTS_PER_YEAR[cap];
}

/**
 * Prices a self-service custom rate-limit selection. Every field is checked
 * against CUSTOM_CAP_MAXIMUMS — a request above the ceiling is rejected
 * (valid: false) rather than silently clamped, so the dashboard can surface
 * exactly which field(s) need to come down before checkout, and the API
 * never accepts a persisted cap set above the hard ceiling.
 */
export function quoteCustomCaps(requested: Partial<RateLimitCaps>): CustomCapQuote {
  const lines: CustomCapQuoteLine[] = [];
  const errors: CustomCapQuote["errors"] = [];

  for (const key of Object.keys(FREE_BASELINE) as (keyof RateLimitCaps)[]) {
    const requestedValue = requested[key] ?? FREE_BASELINE[key];
    const maximum = CUSTOM_CAP_MAXIMUMS[key];

    if (requestedValue > maximum || requestedValue < 0) {
      errors.push({ cap: key, requested: requestedValue, maximum });
      continue;
    }

    const baseline = FREE_BASELINE[key];
    const unitsAboveBaseline = Math.max(0, requestedValue - baseline);
    const lineTotalUsdCents = priceCapLine(key, unitsAboveBaseline);

    lines.push({
      cap: key,
      requested: requestedValue,
      freeBaseline: baseline,
      maximum,
      unitsAboveBaseline,
      lineTotalUsdCents,
    });
  }

  const totalUsdCentsPerYear = lines.reduce((sum, l) => sum + l.lineTotalUsdCents, 0);

  return {
    valid: errors.length === 0,
    errors,
    lines,
    totalUsdCentsPerYear,
  };
}

// ---------------------------------------------------------------------------
// Combined quote — the number actually shown pre-checkout, summing both
// independent axes. Never call the two axes' prices anything but additive:
// no multi-axis discount/bundle logic here by design (e.g. no "custom bot +
// tier2 costs less than buying separately" — each axis is priced and
// charged on its own).
// ---------------------------------------------------------------------------

export interface FullQuoteInput {
  rateLimitTier: RateLimitTier;
  customCaps?: Partial<RateLimitCaps>; // only read when rateLimitTier === "custom"
  hostingMode: HostingMode;
}

export interface FullQuote {
  valid: boolean;
  errors: CustomCapQuote["errors"];
  throughput: {
    tier: RateLimitTier;
    caps: RateLimitCaps;
    price: AnnualPrice;
    customQuote?: CustomCapQuote; // present only for tier === "custom"
  };
  hosting: {
    mode: HostingMode;
    price: AnnualPrice | null; // null when mode === "shared" (free)
  };
  totalUsdCentsPerYear: number;
  totalMonthlyEquivalentUsdCents: number;
  /** True if the combined annual total falls below MINIMUM_CHARGE_CENTS.
   * A real checkout integration should not fire a standalone charge in
   * this case — see the module-level comment and MINIMUM_CHARGE_CENTS. */
  belowMinimumCharge: boolean;
}

export function calculateFullQuote(input: FullQuoteInput): FullQuote {
  let caps: RateLimitCaps;
  let throughputPrice: AnnualPrice;
  let customQuote: CustomCapQuote | undefined;
  let errors: CustomCapQuote["errors"] = [];

  if (input.rateLimitTier === "custom") {
    customQuote = quoteCustomCaps(input.customCaps ?? {});
    errors = customQuote.errors;
    throughputPrice = toAnnualPrice(customQuote.totalUsdCentsPerYear);
    // Even on partial invalidity, surface the best-effort resolved caps
    // (clamped to the ceiling for any invalid field) so the UI has
    // something concrete to render alongside the error list.
    // Built by reduce rather than Object.fromEntries: fromEntries is typed as
    // returning an index signature, and asserting that onto RateLimitCaps is a
    // cast TypeScript rejects as insufficiently overlapping. Accumulating into
    // a typed object keeps every key checked against the interface instead.
    caps = (Object.keys(FREE_BASELINE) as (keyof RateLimitCaps)[]).reduce(
      (acc, key) => {
        acc[key] = Math.min(
          input.customCaps?.[key] ?? FREE_BASELINE[key],
          CUSTOM_CAP_MAXIMUMS[key],
        );
        return acc;
      },
      {} as RateLimitCaps,
    );
  } else {
    const preset = RATE_LIMIT_PRESETS[input.rateLimitTier];
    caps = preset.caps;
    throughputPrice = toAnnualPrice(preset.priceUsdCentsPerYear);
  }

  const hostingPrice = input.hostingMode === "custom" ? customBotHostingPrice() : null;
  const totalUsdCentsPerYear = throughputPrice.annualUsdCents + (hostingPrice?.annualUsdCents ?? 0);

  return {
    valid: errors.length === 0,
    errors,
    throughput: {
      tier: input.rateLimitTier,
      caps,
      price: throughputPrice,
      customQuote,
    },
    hosting: {
      mode: input.hostingMode,
      price: hostingPrice,
    },
    totalUsdCentsPerYear,
    totalMonthlyEquivalentUsdCents: Math.floor(totalUsdCentsPerYear / 12),
    belowMinimumCharge: totalUsdCentsPerYear > 0 && totalUsdCentsPerYear < MINIMUM_CHARGE_CENTS,
  };
}
