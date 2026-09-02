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
  /**
   * Questions on one form.
   *
   * Read this together with shared/lib/modalPaging.ts. An `in_server` form is
   * additionally bounded at MODAL_PAGE_SIZE * MAX_MODAL_PAGES = 25 TEXT
   * questions, because Discord modals hold five components and the paging
   * ceiling is five pages. That bound is Discord's, applies at every tier, and
   * is not something a price can lift.
   *
   * A `direct_message` form has no such limit — dmApplicationService walks
   * questions one at a time — so the cap here is what actually governs it.
   * Select questions are asked before the modal and do not consume modal
   * pages either.
   *
   * The distinction is written down because selling "100 questions" while the
   * main flow silently dropped everything past the fifth is exactly the bug
   * this cap was introduced alongside.
   */
  questionsPerForm: number;
  historyRetentionDays: number;
}

// ---------------------------------------------------------------------------
// Preset tiers — data, not logic, so tuning a number never requires a code
// change beyond this table. Prices are annual, in integer cents.
//
// THE LADDER IS DELIBERATE. A tier has to describe one coherent size of
// server, or it stops being a recommendation and becomes a shopping list. The
// caps below move in three families, each with its own consistent step:
//
//   Throughput — what the server consumes: submissions, tickets, giveaway
//     entries. x5 to tier1, then x4 to tier2. These are the real cost driver
//     and the only ones that scale with community activity.
//
//   Configuration — how elaborate the setup is: forms, panels, roles per rule
//     type. x4 then x2.5, on purpose GENTLER than throughput. A server taking
//     four times the applications does not need four times the forms; it needs
//     the same handful, used harder. tier1 previously granted 50 forms — a 10x
//     jump from free against a 5x jump in the submissions those forms collect,
//     so the tier was sold on a number nobody could exhaust while the cap that
//     actually binds moved a fifth as fast.
//
//   Retention — 30 days, then six months, then two years. Round human
//     durations beat an exact ratio here: "six months of history" is a thing
//     an admin can reason about and 150 days is not.
//
// apiRequestsPerMinute sits outside all three at 60/180/600. It is not a
// product allowance but a protective burst limit on our own API, it scales
// with staff headcount rather than community size, and raising it earns
// nothing while weakening the protection. Left alone knowingly, not missed.
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
      questionsPerForm: 15,
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
      formsPerGuild: 20,
      panelsPerGuild: 20,
      rolesPerRuleType: 10,
      questionsPerForm: 50,
      historyRetentionDays: 180,
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
      formsPerGuild: 50,
      panelsPerGuild: 50,
      rolesPerRuleType: 25,
      questionsPerForm: 100,
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
  questionsPerForm: 200,
  historyRetentionDays: 1_825, // 5 years
};

// Ceiling on how much HISTORICAL submission data a guild may carry in via
// /import-appy, counted across every import rather than per call.
//
// Derived, never sold separately. `historyRetentionDays * submissionsPerDay`
// is already the amount of history a tier is designed to hold — a guild
// generating its cap every day for its full retention window lands exactly
// here — so an import is bounded by the same arithmetic the customer already
// bought instead of by a number invented for imports.
//
// WHY IMPORTS ARE NOT METERED BY submissionsPerDay. That cap is calibrated
// against what a LIVE submission costs: a modal render, a review embed, DM
// sends, role grants, log writes. An imported row costs one INSERT and
// nothing else — no Discord call is made for it at all. Charging historical
// rows against a daily live-traffic cap would measure the wrong resource and
// make migrating off another bot take weeks on the free tier.
//
// WHY THERE IS A CEILING AT ALL. The per-call row limit bounds nothing: it
// caps one file, not a hundred different ones. This is the "no unlimited
// tier, anywhere" backstop applied to the one write path that had no bound.
export function importedSubmissionCeiling(caps: RateLimitCaps): number {
  return caps.historyRetentionDays * caps.submissionsPerDay;
}

// Per-unit ANNUAL price (integer cents) for each unit above the free
// baseline, applied only when rateLimitTier === "custom". Simple arithmetic
// on purpose, so the dashboard can requote on every slider move with no
// server round-trip.
//
// CALIBRATED AGAINST THE PRESET LADDER, not invented independently. Every
// rate is the tier1 price divided across the free -> tier1 gap it has to
// cover, weighted by which caps actually drive cost. The test is at the top
// of this file's history and worth repeating: pricing a custom set at
// EXACTLY tier1's caps must land on tier1's price. It comes to $59.01
// against $60. Tier2's caps come to $255.61 against $180 — 1.42x — which is
// the shape we want, since a preset should be the cheaper way to buy a
// preset and custom should cost a little extra for being shaped to you.
//
// These two numbers were previously unrelated systems. Presets were flat
// bundles; custom was linear from the free baseline at rates chosen with no
// reference to them. They disagreed by a factor of 23.7 at tier1's caps and
// 19.3 at tier2's — buying tier2's exact caps through the custom builder cost
// $3,474 against $180 for the same thing one click away, so custom was not a
// product, it was a trap for anyone who found it. The ceiling now prices at
// $1,275.81/year rather than $12,226.80.
//
// Anything changing a preset's caps or price MUST rerun that calibration.
// The failure is silent: the numbers stay individually plausible and only the
// relationship between them breaks, which is exactly how it broke before.
//
// giveawayEntriesPerDay is absent from this table because its rate is a
// fraction of a cent per entry and every constant here must be an integer.
// It is priced below per 100 units instead.
const CUSTOM_CAP_UNIT_PRICE_CENTS_PER_YEAR: Record<
  Exclude<keyof RateLimitCaps, "giveawayEntriesPerDay">,
  number
> = {
  // Throughput carries most of the price, because it is what actually costs
  // us anything: $20 of tier1 across its 400 extra submissions/day, $10
  // across its 200 extra tickets.
  submissionsPerDay: 5, // $0.05/yr per submission/day
  ticketsPerDay: 5,
  // 9 rather than 8 so a custom set at tier1's exact caps clears tier1's $60
  // instead of landing at $59.01. A preset that costs more than assembling it
  // by hand cannot be sold, and the gap was small enough to look like nothing.
  apiRequestsPerMinute: 9, // $0.09/yr per request/minute
  // Configuration caps are cheap per unit and few in number, so they add a
  // modest amount to a custom set rather than dominating it. Under the old
  // table these three alone accounted for $1,152 of the $1,424 tier1-caps
  // quote — the price was set by the axis that costs us the least to serve.
  formsPerGuild: 33, // $0.33/yr per form
  panelsPerGuild: 33,
  rolesPerRuleType: 43, // $0.43/yr per role per rule type
  // Cheap per unit: a question costs one row and, per submission, one
  // answer row. The ladder above is what carries the price.
  questionsPerForm: 10, // $0.10/yr per question
  historyRetentionDays: 1, // $0.01/yr per extra day of history
};

const GIVEAWAY_ENTRIES_PRICE_CENTS_PER_100_PER_YEAR = 25; // 25 cents per 100 entries/day

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

// $30.00/year.
//
// Was $10, set before there was anything to host. Now that dedicated hosting
// actually provisions something, the cost is knowable: a runner process holds
// MAX_BOTS_PER_RUNNER clients (bot/src/core/dedicatedRunner.ts) on an
// always-on instance costing roughly $84/year, so about $5.60 per bot.
//
// $10 would be a 44% margin on a feature carrying real operational surface —
// runners to watch, customers' bot tokens to hold, and people who notice
// within minutes when their own bot goes down. $30 covers that with room for
// a runner sitting half-empty, which is the normal case at low volume and the
// case a per-bot average quietly assumes away.
export const CUSTOM_BOT_HOSTING_USD_CENTS_PER_YEAR = 3_000;

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
    // Priced per 100 units to keep the per-unit constant a whole cent.
    return Math.round((unitsAboveBaseline / 100) * GIVEAWAY_ENTRIES_PRICE_CENTS_PER_100_PER_YEAR);
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

/**
 * The role arrays a form carries. Each one is a "rule type" for the
 * `rolesPerRuleType` cap.
 *
 * That cap was priced from the beginning — $0.43/yr per role per rule type —
 * and enforced nowhere, because "rule type" appeared in no code anywhere
 * outside the cap's own name. There was nothing to enforce it against. This
 * list is what it now means.
 *
 * Written out rather than derived from the schema on purpose: adding a role
 * array to `forms` should be a deliberate decision about whether it is
 * billable, not a silent one that changes what customers are charged.
 */
/** Display names for the role arrays, for messages an admin reads.
 *
 * The 429/400 body names the offending fields, which is the point of it —
 * but "grantRoleIds" is a column name, not what the role picker above it is
 * labelled. Naming the wrong thing precisely is its own kind of unhelpful. */
export const FORM_ROLE_RULE_LABELS: Record<string, string> = {
  grantRoleIds: "Roles granted on accept",
  removeRoleIds: "Roles removed on accept",
  deniedGrantRoleIds: "Roles granted on deny",
  denyRemoveRoleIds: "Roles removed on deny",
  pendingRoleIds: "Roles while pending",
  removeRolesOnSubmitIds: "Roles removed on submit",
  pingRoleIds: "Roles pinged",
  requiredRoleIds: "Required roles",
  blacklistedRoleIds: "Blacklisted roles",
  reviewerRoleIds: "Reviewer roles",
};

/**
 * The rules where trimming the list WIDENS access rather than narrowing it.
 *
 * requiredRoleIds and blacklistedRoleIds decide who may apply. Drop two of
 * five required roles and MORE people qualify; drop a blacklist entry and
 * someone barred becomes eligible. Every other rule decides what happens
 * AFTER a decision — trimming those grants fewer roles or pings fewer people,
 * which is wrong but not an open door.
 *
 * dataImport.ts relies on this split: an import that has to trim a gate
 * brings the form in switched off, the same rule that already applies when a
 * gate's roles fail to map. See the header of that file.
 */
export const FORM_GATING_ROLE_RULES = [
  "requiredRoleIds",
  "blacklistedRoleIds",
] as const;

export const FORM_ROLE_RULES = [
  "grantRoleIds",
  "removeRoleIds",
  "deniedGrantRoleIds",
  "denyRemoveRoleIds",
  "pendingRoleIds",
  "removeRolesOnSubmitIds",
  "pingRoleIds",
  "requiredRoleIds",
  "blacklistedRoleIds",
  "reviewerRoleIds",
] as const;

export type FormRoleRule = (typeof FORM_ROLE_RULES)[number];

export interface RoleCapViolation {
  rule: FormRoleRule;
  count: number;
  limit: number;
}

/**
 * Which of a form's role arrays exceed `limit`.
 *
 * GRANDFATHERED, and that is the whole design. An array already over the cap
 * may be kept or reduced, never grown. Because this cap was sold and never
 * enforced, live forms can legitimately hold more roles than their tier
 * allows — rejecting those on the next unrelated edit would turn a billing
 * correction into an outage for exactly the people who used the feature most.
 *
 * `previous` is undefined when creating, where there is nothing to
 * grandfather and the cap applies in full.
 */
export function findRoleCapViolations(
  next: Partial<Record<FormRoleRule, string[]>>,
  previous: Partial<Record<FormRoleRule, string[]>> | undefined,
  limit: number,
): RoleCapViolation[] {
  const out: RoleCapViolation[] = [];
  for (const rule of FORM_ROLE_RULES) {
    const count = next[rule]?.length ?? 0;
    if (count <= limit) continue;

    // "Kept or reduced" is meant literally: no id may appear that was not
    // already stored. Comparing lengths alone would let an over-cap array be
    // swapped wholesale for a different set of the same size — which is not
    // the old configuration surviving, it is a new one at a size the plan
    // does not allow.
    const before = previous?.[rule];
    if (before && count <= before.length) {
      const kept = new Set(before);
      if ((next[rule] ?? []).every((id) => kept.has(id))) continue;
    }

    out.push({ rule, count, limit });
  }
  return out;
}
