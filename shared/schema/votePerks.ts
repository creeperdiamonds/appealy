// shared/schema/votePerks.ts
//
// What a top.gg vote buys a server. Shared because three processes touch it:
// the API records the vote (routes/topggWebhook.ts), the bot lets the voter
// spend it (/vote) and enforces it (rateLimitService.ts), and the dashboard's
// capacity panel shows it (api routes/overview.ts).
//
// ---------------------------------------------------------------------------
// Why the perks are this small
// ---------------------------------------------------------------------------
// A vote is free and repeats every 12 hours, so anything it buys can be
// farmed — by a selfbot, or by twenty alts. The perks are sized so farming
// isn't worth it: ONE perk per server at a time, a new vote replaces it
// rather than stacking, and the biggest is a third of the free daily limit.
// Voting non-stop with every alt in the world still leaves a server far
// below Tier 1, so better limits are still something you buy.
//
// Only the daily caps. A bonus to forms or panels would expire with forms
// still standing above the limit, and someone has to decide which ones stop
// working. A daily allowance just stops being bigger.

/** The daily caps a perk can raise. Matches DailyCapName in the bot. */
export type VotePerkCap = "submissionsPerDay" | "ticketsPerDay" | "giveawayEntriesPerDay";

export interface VotePerk {
  id: string;
  cap: VotePerkCap;
  bonus: number;
  /** For the select menu: "+50 applications a day". */
  label: string;
}

export const VOTE_PERKS: readonly VotePerk[] = [
  { id: "submissions", cap: "submissionsPerDay", bonus: 50, label: "+50 applications a day" },
  { id: "tickets", cap: "ticketsPerDay", bonus: 25, label: "+25 tickets a day" },
  { id: "giveaway", cap: "giveawayEntriesPerDay", bonus: 250, label: "+250 giveaway entries a day" },
];

/** How long a claimed perk lasts. Longer than the 12h vote window on
 * purpose, so voting each time it's allowed never leaves a gap. */
export const VOTE_PERK_SECONDS = 24 * 60 * 60;

/** Fallback for how long an unspent vote waits, when top.gg doesn't say. */
export const UNSPENT_VOTE_SECONDS = 12 * 60 * 60;

/** An unspent vote, written by the webhook, taken (GETDEL) by /vote. */
export const voteKey = (userId: string) => `appealy:vote:${userId}`;

/** The server's active perk. One key per server is what stops stacking. */
export const votePerkKey = (guildId: string) => `appealy:voteperk:${guildId}`;

export interface ActiveVotePerk {
  perk: string;
  userId: string;
  /** Epoch ms. The key's TTL is what actually ends it; this is for display. */
  until: number;
}

export function findPerk(id: string): VotePerk | undefined {
  return VOTE_PERKS.find((p) => p.id === id);
}

/** Reads a stored perk, or null for anything missing, expired or malformed. */
export function parseActivePerk(raw: string | null | undefined, now = Date.now()): ActiveVotePerk | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ActiveVotePerk>;
    if (typeof v.perk !== "string" || typeof v.until !== "number" || !findPerk(v.perk)) return null;
    if (v.until <= now) return null;
    return { perk: v.perk, userId: String(v.userId ?? ""), until: v.until };
  } catch {
    return null;
  }
}

/** The extra allowance an active perk adds to one cap. 0 when it's for another. */
export function voteBonus(active: ActiveVotePerk | null, cap: string): number {
  if (!active) return 0;
  const perk = findPerk(active.perk);
  return perk && perk.cap === cap ? perk.bonus : 0;
}

/** Caps with the active perk added. Returns the same object when nothing changes. */
export function withVoteBonus<T extends Record<VotePerkCap, number>>(caps: T, active: ActiveVotePerk | null): T {
  const perk = active ? findPerk(active.perk) : undefined;
  if (!perk) return caps;
  return { ...caps, [perk.cap]: caps[perk.cap] + perk.bonus };
}
