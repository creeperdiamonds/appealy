// bot/src/core/entitlements.ts
//
// Discord App Subscriptions — tier resolution from entitlements.
//
// ---------------------------------------------------------------------------
// Why this exists alongside Tebex
// ---------------------------------------------------------------------------
// Discord's Monetization Requirements policy says an app offering paid
// capabilities must also offer them through Premium Apps, at a price no higher
// than elsewhere. So Discord subscriptions were never really optional next to
// a web checkout — and they overlap with most of what Tebex is for:
//
//   - Discord is merchant of record, as Tebex is. No payment processor to
//     onboard, no PCI surface, no VAT/sales-tax handling of your own.
//   - Purchase happens inside Discord. No redirect to a checkout page.
//   - Guild subscriptions map directly onto this codebase's per-guild tiers.
//
// What Discord cannot do is the custom-caps tier: its SKUs are a fixed
// catalogue, and an admin choosing their own numbers produces a price that
// exists only at request time. That is the case Tebex's inline packages cover,
// and the reason both paths exist rather than one.
//
// The cost is the platform fee (15% under $1M cumulative, 30% after) and
// availability limited to US/UK/EU-based developers. Both are decisions for
// you, not this file.
//
// ---------------------------------------------------------------------------
// Entitlements are the source of truth, not subscriptions
// ---------------------------------------------------------------------------
// Discord is explicit about this: use the presence of an ENTITLEMENT to decide
// whether someone has premium. The Subscriptions API is for reporting and
// lifecycle, and reading it to gate features gets the edge cases wrong.
//
// The event model has one shape worth internalizing, because it's the opposite
// of what most billing integrations do:
//
//   ENTITLEMENT_CREATE   purchase happened
//   ENTITLEMENT_UPDATE   ONLY when a subscription ends, carrying `ends_at`
//   (renewals emit nothing at all)
//
// So "no events for six months" means a healthy active subscription, not a
// dropped webhook. Code that treats silence as expiry will cancel every paying
// customer. Active is the default state; an entitlement is live until an
// `ends_at` in the past says otherwise.
//
// ---------------------------------------------------------------------------
// Three sources, deliberately
// ---------------------------------------------------------------------------
// 1. Gateway events        — instant, but missable across a reconnect gap.
// 2. Interaction payloads  — every interaction carries the caller's
//                            entitlements. Free, no API call, self-healing.
// 3. Periodic reconcile    — GET /applications/{id}/entitlements, hourly.
//
// (2) is the quietly important one. Even if the gateway drops an event, the
// next command in that guild repairs the cache at zero cost.

import { logger } from "../utils/logger.ts";
import { env } from "./env.ts";
import type { RateLimitTier } from "../../../shared/schema/pricing.ts";

interface Entitlement {
  id: string;
  sku_id: string;
  guild_id?: string;
  user_id?: string;
  /** null = active indefinitely. A past timestamp = expired. */
  ends_at?: string | null;
  deleted?: boolean;
}

/** guildId -> tier, for guilds with a live entitlement. */
const guildTiers = new Map<string, RateLimitTier>();
/** userId -> tier, for user subscriptions. */
const userTiers = new Map<string, RateLimitTier>();

let ready = false;

/** An entitlement with no ends_at, or one still in the future, is live. */
function isLive(e: Entitlement): boolean {
  if (e.deleted) return false;
  if (!e.ends_at) return true; // active indefinitely — the normal case
  return new Date(e.ends_at).getTime() > Date.now();
}

function tierForSku(skuId: string): RateLimitTier | null {
  return env.DISCORD_SKU_TIERS[skuId] ?? null;
}

function apply(e: Entitlement): void {
  const tier = tierForSku(e.sku_id);
  if (!tier) {
    // A SKU we don't recognize. Loud, because the usual cause is a SKU created
    // in the dev portal and never added to DISCORD_SKU_TIERS — which means a
    // paying customer is silently getting nothing.
    logger.warn("Entitlement for an unmapped SKU — customer may be paying for nothing", {
      skuId: e.sku_id,
      guildId: e.guild_id,
      userId: e.user_id,
      hint: "Add it to DISCORD_SKU_TIERS in .env",
    });
    return;
  }

  const live = isLive(e);
  if (e.guild_id) {
    if (live) guildTiers.set(e.guild_id, tier);
    else guildTiers.delete(e.guild_id);
  }
  if (e.user_id) {
    if (live) userTiers.set(e.user_id, tier);
    else userTiers.delete(e.user_id);
  }
}

/** Gateway ENTITLEMENT_CREATE / UPDATE / DELETE. */
export function onEntitlementEvent(kind: "create" | "update" | "delete", e: Entitlement): void {
  apply(kind === "delete" ? { ...e, deleted: true } : e);
  logger.info("Entitlement event", {
    kind,
    skuId: e.sku_id,
    guildId: e.guild_id,
    endsAt: e.ends_at ?? null,
    // Worth logging explicitly: an update WITHOUT ends_at is not a renewal
    // (renewals are silent) — it's unusual and worth noticing.
    note: kind === "update" && !e.ends_at ? "update with no ends_at — unexpected" : undefined,
  });
}

/**
 * Entitlements attached to an interaction payload.
 *
 * The cheapest correct source there is: it costs nothing, arrives on every
 * command, and repairs anything the gateway missed. Call it from the
 * interaction handler before dispatch.
 */
export function absorbFromInteraction(entitlements: Entitlement[] | undefined): void {
  if (!entitlements?.length) return;
  for (const e of entitlements) apply(e);
}

/** Full reconcile. Catches whatever the gateway dropped while disconnected. */
export async function reconcileEntitlements(): Promise<void> {
  if (Object.keys(env.DISCORD_SKU_TIERS).length === 0) return;

  try {
    // exclude_ended=true so expired entitlements don't need filtering here.
    const url =
      `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}` +
      `/entitlements?exclude_ended=true&limit=100`;

    const res = await fetch(url, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
    if (!res.ok) {
      logger.warn("Entitlement reconcile failed", { status: res.status });
      return;
    }

    const live: Entitlement[] = await res.json();

    // Rebuild rather than merge. A subscription that ended while we were
    // disconnected produces no event to process, so merging would leave it
    // granted forever — the only way to notice a disappearance is a full
    // replace.
    guildTiers.clear();
    userTiers.clear();
    for (const e of live) apply(e);

    ready = true;
    logger.info("Entitlements reconciled", { guilds: guildTiers.size, users: userTiers.size });
  } catch (err) {
    logger.warn("Entitlement reconcile threw", { err: String(err) });
  }
}

export function startEntitlements(): void {
  if (Object.keys(env.DISCORD_SKU_TIERS).length === 0) {
    logger.info("Discord subscriptions not configured (no DISCORD_SKU_TIERS) — billing off");
    return;
  }
  void reconcileEntitlements();
  const timer = setInterval(() => void reconcileEntitlements(), 3_600_000);
  if (typeof Deno !== "undefined") Deno.unrefTimer(timer);
}

/**
 * Tier for a guild, or null if it has no live entitlement.
 *
 * Fails OPEN in the sense that matters: if we haven't reconciled yet, this
 * returns null and the guild falls back to its stored tier rather than being
 * downgraded. A paying customer briefly on their database tier is fine; a
 * paying customer downgraded to free because a fetch was slow is not.
 */
export function entitledTier(guildId: bigint, userId?: bigint): RateLimitTier | null {
  if (!ready) return null;
  return (
    guildTiers.get(guildId.toString()) ??
    (userId ? userTiers.get(userId.toString()) ?? null : null)
  );
}

export function entitlementStats() {
  return { ready, guilds: guildTiers.size, users: userTiers.size };
}
