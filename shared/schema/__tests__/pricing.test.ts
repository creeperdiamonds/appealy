// shared/schema/__tests__/pricing.test.ts
//
// Run with: deno test shared/schema/__tests__/pricing.test.ts
//
// Guards the one property that is easy to break and impossible to see: the
// preset ladder and the custom per-unit rates are two ways of pricing the
// same thing, and they must agree.
//
// They did not, for a long time. Presets were flat bundles, custom was linear
// from the free baseline, and the two tables were tuned independently — so
// buying tier2's exact caps through the custom builder cost $3,474 against
// $180 for the identical caps one click away, a factor of 19.3. Nothing threw,
// no test failed, and each table looked reasonable read on its own. That is
// precisely why this is a test and not a comment asking the next person to
// remember.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CUSTOM_CAP_MAXIMUMS,
  MINIMUM_CHARGE_CENTS,
  RATE_LIMIT_PRESETS,
  calculateFullQuote,
  quoteCustomCaps,
  type RateLimitCaps,
} from "../pricing.ts";

const caps = (t: "free" | "tier1" | "tier2") => RATE_LIMIT_PRESETS[t].caps;
const price = (t: "free" | "tier1" | "tier2") => RATE_LIMIT_PRESETS[t].priceUsdCentsPerYear;

/** How far a custom quote for these caps sits from the preset selling them. */
function ratioToPreset(tier: "tier1" | "tier2"): number {
  return quoteCustomCaps(caps(tier)).totalUsdCentsPerYear / price(tier);
}

Deno.test("custom pricing at tier1's caps lands on tier1's price", () => {
  // The calibration anchor. Rates are derived from this gap, so drift here
  // means the rates no longer descend from the ladder they claim to.
  const ratio = ratioToPreset("tier1");
  assertEquals(
    ratio > 0.9 && ratio < 1.1,
    true,
    `custom at tier1 caps is ${ratio.toFixed(2)}x tier1's price; expected within 10%`,
  );
});

Deno.test("a preset is never a worse deal than building it by hand", () => {
  // The direction matters more than the magnitude. If custom is CHEAPER than
  // the preset covering the same caps, the preset is unsellable and the
  // builder is the only rational choice — which is the mirror of the bug this
  // file exists for, and just as invisible.
  for (const tier of ["tier1", "tier2"] as const) {
    assertEquals(
      quoteCustomCaps(caps(tier)).totalUsdCentsPerYear >= price(tier),
      true,
      `${tier} costs more than building its own caps in the custom builder`,
    );
  }
});

Deno.test("custom stays within a sane multiple of the preset it resembles", () => {
  // Some premium is correct — custom is shaped to you and presets are a bundle
  // discount. An order of magnitude is not a premium, it is a wall.
  const ratio = ratioToPreset("tier2");
  assertEquals(
    ratio < 2,
    true,
    `custom at tier2 caps is ${ratio.toFixed(2)}x tier2's price; a premium above 2x reads as a trap`,
  );
});

Deno.test("the ceiling prices to something a customer could actually pay", () => {
  const total = quoteCustomCaps(CUSTOM_CAP_MAXIMUMS).totalUsdCentsPerYear;
  assertEquals(quoteCustomCaps(CUSTOM_CAP_MAXIMUMS).valid, true);
  // Every cap at its hard maximum is the most expensive request the system can
  // express. It should read as an enterprise number, not a decimal error.
  assertEquals(
    total > 50_000 && total < 300_000,
    true,
    `everything at maximum prices at $${(total / 100).toFixed(2)}/year`,
  );
});

Deno.test("the caps ladder only ever increases", () => {
  const keys = Object.keys(caps("free")) as (keyof RateLimitCaps)[];
  for (const key of keys) {
    assertEquals(
      caps("free")[key] <= caps("tier1")[key] &&
        caps("tier1")[key] <= caps("tier2")[key] &&
        caps("tier2")[key] <= CUSTOM_CAP_MAXIMUMS[key],
      true,
      `${key} does not increase across free -> tier1 -> tier2 -> ceiling`,
    );
  }
});

Deno.test("free is free and costs nothing to quote", () => {
  const quote = calculateFullQuote({ rateLimitTier: "free", hostingMode: "shared" });
  assertEquals(quote.totalUsdCentsPerYear, 0);
  // Zero is not "below the minimum charge" — there is nothing to charge, which
  // is a different state from an amount too small to bill.
  assertEquals(quote.belowMinimumCharge, false);
});

Deno.test("a custom set barely above free is flagged rather than billed", () => {
  const quote = calculateFullQuote({
    rateLimitTier: "custom",
    customCaps: { ...caps("free"), submissionsPerDay: caps("free").submissionsPerDay + 1 },
    hostingMode: "shared",
  });
  assertEquals(quote.totalUsdCentsPerYear > 0, true);
  assertEquals(quote.totalUsdCentsPerYear < MINIMUM_CHARGE_CENTS, true);
  assertEquals(quote.belowMinimumCharge, true);
});

Deno.test("a request above any ceiling is rejected, not clamped", () => {
  const quote = quoteCustomCaps({
    ...caps("free"),
    submissionsPerDay: CUSTOM_CAP_MAXIMUMS.submissionsPerDay + 1,
  });
  assertEquals(quote.valid, false);
  assertEquals(quote.errors.length, 1);
  assertEquals(quote.errors[0].cap, "submissionsPerDay");
});
