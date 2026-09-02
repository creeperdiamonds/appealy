// api/src/services/rateLimitService.ts
//
// API-side counterpart to bot/src/services/rateLimitService.ts. The API
// only needs to check "standing" caps (forms/panels per guild) — the
// per-day event caps (submissions, tickets, giveaway entries) are enforced
// by the bot at the point of the Discord interaction, since that's where
// the volume actually happens; duplicating that Redis-window logic here
// would just create two sources of truth for the same counter.
//
// Both this file and the bot's version call the same pure resolver logic
// from shared/schema/pricing.ts for the tier presets themselves — but they
// are NOT guaranteed to resolve a guild's effective caps identically.
//
// The bot's resolveEffectiveCaps checks a live Discord entitlement
// (entitledTier(), bot/src/core/entitlements.ts) before falling back to
// guild.rateLimitTier; this file goes straight from the self-mode check to
// the stored column. That's not an oversight this file can fix on its own:
// entitledTier() reads in-process Maps in entitlements.ts that are populated
// from Discord's gateway/REST and never persisted anywhere the API process
// can reach. Sharing that state between the two processes is a real project,
// not something to paper over here.
//
// This divergence is DORMANT today: production logs "Discord subscriptions
// not configured (no DISCORD_SKU_TIERS) → billing off", so entitledTier()
// always returns null and the bot falls through to the same stored tier this
// file reads. It goes LIVE the moment someone sets DISCORD_SKU_TIERS — from
// then on, a customer who bought through Discord's native subscription will
// see the bot enforce their entitled tier's caps while the dashboard (this
// file) keeps showing and enforcing whatever guild.rateLimitTier last had
// written to it, until entitlement state is shared between the two
// processes. If you're the one turning DISCORD_SKU_TIERS on: this is the
// place that needs that sharing built before the caps can be trusted to
// agree.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import {
  RATE_LIMIT_PRESETS,
  CUSTOM_CAP_MAXIMUMS,
  findRoleCapViolations,
  type FormRoleRule,
  type RateLimitCaps,
  type RoleCapViolation,
} from "../../../shared/schema/pricing.ts";
import {
  countTextQuestions,
  findQuestionLimitViolations,
  type QuestionLimitViolation,
  type QuestionShape,
} from "../../../shared/lib/formLimits.ts";
import { deployment, env, PRIVILEGED } from "../env.ts";

const FREE_CAPS = RATE_LIMIT_PRESETS.free.caps;

/**
 * Self-hosted caps, built once from env.
 *
 * A tier is a billing concept and a self-hoster has no billing, so every
 * guild on a self-hosted instance gets the same flat numbers. The caps still
 * exist — they protect the operator's own Postgres pool, which is the real
 * constraint — but they are no longer a product ladder, and the person who
 * sets them owns the database they protect.
 *
 * Anything in RateLimitCaps that has no CAP_* env equivalent falls back to
 * the tier2 preset rather than to free: a self-hoster should never be more
 * restricted than a paying customer on their own hardware.
 */
const SELF_HOSTED_CAPS: RateLimitCaps = {
  ...RATE_LIMIT_PRESETS.tier2.caps,
  ...env.SELF_HOSTED_CAPS,
};

/**
 * Caps for privileged guilds. CUSTOM_CAP_MAXIMUMS unless a PRIVILEGED_CAP_*
 * says otherwise — "as high as this system was designed to go" is a safer
 * starting point than an invented number, and the overrides are there for
 * when it genuinely isn't enough.
 *
 * Still finite. Your own server shares the same Postgres pool as every other
 * guild, so an uncapped runaway loop in it takes everyone down with it.
 */
const PRIVILEGED_CAPS: RateLimitCaps = {
  ...CUSTOM_CAP_MAXIMUMS,
  ...PRIVILEGED.overrides,
};


export function resolveEffectiveCaps(guild: typeof schema.guilds.$inferSelect): RateLimitCaps {
  // Privileged guilds win over everything — tier, custom caps, self mode.
  // This is the operator's own server, granted by env, and it is deliberately
  // NOT clamped to CUSTOM_CAP_MAXIMUMS: that ceiling exists to stop a customer
  // self-serving unbounded throughput, and there is no purchase to bound here.
  if (PRIVILEGED.ids.has(guild.id.toString())) {
    return PRIVILEGED_CAPS;
  }

  // Checked before the tier is read at all. In self mode `guild.rateLimitTier`
  // is meaningless — it defaults to "free" on every row, and honouring it
  // would cap a self-hoster with someone else's price list.
  if (!deployment.features.tieredRateLimits) {
    return SELF_HOSTED_CAPS;
  }

  if (guild.rateLimitTier !== "custom") {
    return RATE_LIMIT_PRESETS[guild.rateLimitTier].caps;
  }
  const stored = guild.customRateLimits ?? {};
  const resolved = {} as RateLimitCaps;
  for (const key of Object.keys(FREE_CAPS) as (keyof RateLimitCaps)[]) {
    const requested = stored[key] ?? FREE_CAPS[key];
    resolved[key] = Math.min(requested, CUSTOM_CAP_MAXIMUMS[key]);
  }
  return resolved;
}

export interface StandingCapCheck {
  allowed: boolean;
  current: number;
  limit: number;
}

export async function checkStandingCap(
  guildId: bigint,
  capName: "formsPerGuild" | "panelsPerGuild",
  currentCount: number,
): Promise<StandingCapCheck> {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  const caps = guild ? resolveEffectiveCaps(guild) : FREE_CAPS;
  const limit = caps[capName];
  return { allowed: currentCount < limit, current: currentCount, limit };
}

/**
 * Check a form's role arrays against this guild's `rolesPerRuleType`.
 *
 * Called from the form routes and the outcome routes. The comparison itself
 * lives in shared/schema/pricing.ts, where deno test covers it; this function
 * only resolves the guild's number.
 *
 * NOT the only way a form is written, and an earlier version of this comment
 * wrongly said it was. shared/services/dataImport.ts inserts forms too,
 * reached from both api/src/routes/migration.ts and the bot's
 * /import-appealy command, and neither calls this function.
 *
 * That path enforces the same cap by a different mechanism, because it has a
 * different job: a route can reject and ask the admin to fix their input,
 * while an import is a bulk migration whose whole design is partial success
 * plus a report. It clamps instead, and splits on consequence — an over-cap
 * GATE (requiredRoleIds, blacklistedRoleIds) brings the form in switched off,
 * since admitting more people than the source server did is the same open
 * door as a gate whose roles failed to map, while an over-cap grant or ping
 * list is simply trimmed and reported. See clampRoleIds and
 * trimmingWidensAccess there, both covered by deno test.
 */
export async function checkRoleRuleCaps(
  guildId: bigint,
  next: Partial<Record<FormRoleRule, string[]>>,
  previous?: Partial<Record<FormRoleRule, string[]>>,
): Promise<RoleCapViolation[]> {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  const caps = guild ? resolveEffectiveCaps(guild) : FREE_CAPS;
  return findRoleCapViolations(next, previous, caps.rolesPerRuleType);
}

/**
 * Check a form's questions against the guild's `questionsPerForm` AND against
 * Discord's modal ceiling.
 *
 * The comparison lives in shared/lib/formLimits.ts, where deno test covers it;
 * this only resolves the guild's number. Same division of labour as
 * checkRoleRuleCaps above.
 *
 * Both limits are checked here because only one of them is a price. A tier
 * raises questionsPerForm; nothing raises the modal ceiling, because five
 * components per modal is Discord's rule. Returning them together means a
 * caller cannot enforce the purchasable one and forget the other, which is how
 * the original bug worked — the form accepted questions the flow then dropped.
 */
export async function checkQuestionLimits(
  guildId: bigint,
  opts: {
    questions: QuestionShape[];
    applicationType: string | null | undefined;
    /** The form's stored questions, when editing. Grandfathers an over-limit form. */
    previous?: QuestionShape[];
  },
): Promise<QuestionLimitViolation[]> {
  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  const caps = guild ? resolveEffectiveCaps(guild) : FREE_CAPS;
  return findQuestionLimitViolations({
    questions: opts.questions,
    tierLimit: caps.questionsPerForm,
    applicationType: opts.applicationType,
    previousCount: opts.previous?.length,
    previousTextCount: opts.previous ? countTextQuestions(opts.previous) : undefined,
  });
}
