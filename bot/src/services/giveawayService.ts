// bot/src/services/giveawayService.ts
//
// Core giveaway logic: publishing, entry gating, ending + weighted winner
// selection, and rerolling. Kept separate from the interaction handler and
// the scheduler so both can call the same "end" logic without duplicating
// the winner-selection algorithm.

import { eq, and, sql } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { countRows } from "../db/count.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { logger } from "../utils/logger.ts";

export interface EntryCheckResult {
  allowed: boolean;
  reason?: "missing_required_role" | "has_blacklisted_role" | "giveaway_ended" | "already_entered";
}

export function checkEntryEligibility(
  giveaway: typeof schema.giveaways.$inferSelect,
  memberRoleIds: string[],
  alreadyEntered: boolean,
): EntryCheckResult {
  if (giveaway.status !== "running") return { allowed: false, reason: "giveaway_ended" };
  if (alreadyEntered) return { allowed: false, reason: "already_entered" };

  if (giveaway.requiredRoleIds.length > 0) {
    const hasRequired = giveaway.requiredRoleIds.some((r) => memberRoleIds.includes(r));
    if (!hasRequired) return { allowed: false, reason: "missing_required_role" };
  }
  if (giveaway.blacklistedRoleIds.length > 0) {
    const hasBlacklisted = giveaway.blacklistedRoleIds.some((r) => memberRoleIds.includes(r));
    if (hasBlacklisted) return { allowed: false, reason: "has_blacklisted_role" };
  }

  return { allowed: true };
}

export async function renderGiveawayEmbed(giveaway: typeof schema.giveaways.$inferSelect) {
  const entryCount = await countRows(schema.giveawayEntries, eq(schema.giveawayEntries.giveawayId, giveaway.id));

  const isEnded = giveaway.status === "ended";
  return {
    title: isEnded ? `🎉 Giveaway Ended: ${giveaway.prize}` : `🎉 ${giveaway.prize}`,
    description: isEnded
      ? giveaway.winnerIds.length > 0
        ? `Winner(s): ${giveaway.winnerIds.map((id) => `<@${id}>`).join(", ")}`
        : "No valid entries — no winner could be selected."
      : `React with the button below to enter!\n\n**Winners:** ${giveaway.winnerCount}\n**Entries:** ${entryCount}${
          giveaway.endsAt ? `\n**Ends:** <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>` : ""
        }`,
    color: isEnded ? 0x99aab5 : 0x5865f2,
    footer: { text: `Giveaway ID: ${giveaway.id}` },
  };
}

export async function publishGiveaway(bot: AppealyBot, giveawayId: string) {
  const giveaway = await db.query.giveaways.findFirst({ where: eq(schema.giveaways.id, giveawayId) });
  if (!giveaway) throw new Error("giveaway_not_found");

  const embed = await renderGiveawayEmbed(giveaway);
  const message = await bot.helpers.sendMessage(giveaway.channelId, {
    embeds: [embed],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "🎉 Enter Giveaway",
            customId: encodeCustomId("giveaway", "enter", giveaway.id),
          },
        ],
      },
    ],
  });

  await db
    .update(schema.giveaways)
    .set({ status: "running", messageId: message.id })
    .where(eq(schema.giveaways.id, giveawayId));
}

/** Builds a weighted candidate pool where each entrant appears once plus
 * once per matching bonusRoleEntries rule, then samples winnerCount unique
 * users from it (a user can't win twice even if their weighted slots would
 * otherwise let them be drawn more than once). */
export async function endGiveaway(bot: AppealyBot, giveawayId: string, isReroll = false) {
  const giveaway = await db.query.giveaways.findFirst({ where: eq(schema.giveaways.id, giveawayId) });
  if (!giveaway) throw new Error("giveaway_not_found");

  const entries = await db
    .select()
    .from(schema.giveawayEntries)
    .where(eq(schema.giveawayEntries.giveawayId, giveawayId));

  const excludeIds = isReroll ? new Set(giveaway.winnerIds) : new Set<string>();
  const eligibleEntrantIds = entries.map((e) => e.userId.toString()).filter((id) => !excludeIds.has(id));

  const winners = drawWinners(eligibleEntrantIds, giveaway.bonusRoleEntries, giveaway.winnerCount, bot, giveaway.guildId);
  const winnerIds = await winners;

  await db
    .update(schema.giveaways)
    .set({
      status: "ended",
      endedAt: new Date(),
      winnerIds: isReroll ? [...giveaway.winnerIds, ...winnerIds] : winnerIds,
    })
    .where(eq(schema.giveaways.id, giveawayId));

  if (giveaway.messageId) {
    const refreshed = await db.query.giveaways.findFirst({ where: eq(schema.giveaways.id, giveawayId) });
    if (refreshed) {
      try {
        const embed = await renderGiveawayEmbed(refreshed);
        await bot.helpers.editMessage(giveaway.channelId, giveaway.messageId, { embeds: [embed], components: [] });
      } catch {
        // non-fatal — winners are still recorded even if the message edit fails
      }
    }
  }

  if (winnerIds.length > 0) {
    try {
      await bot.helpers.sendMessage(giveaway.channelId, {
        content: `Congratulations ${winnerIds.map((id) => `<@${id}>`).join(", ")}! You won **${giveaway.prize}**.`,
      });
    } catch (err) {
      logger.warn("Failed to post giveaway winner announcement", { giveawayId, error: String(err) });
    }
  } else {
    try {
      await bot.helpers.sendMessage(giveaway.channelId, {
        content: `No valid entries for **${giveaway.prize}** — no winner could be selected.`,
      });
    } catch {
      // non-fatal
    }
  }

  return winnerIds;
}

async function drawWinners(
  entrantIds: string[],
  bonusRoleEntries: { roleId: string; extraEntries: number }[],
  count: number,
  bot: AppealyBot,
  guildId: bigint,
): Promise<string[]> {
  if (entrantIds.length === 0) return [];

  // Build a weighted pool. Bonus entries require a member-role lookup per
  // entrant; skipped gracefully (treated as base weight 1) if the member
  // can no longer be fetched (e.g. they left after entering).
  const pool: string[] = [];
  for (const userId of entrantIds) {
    let weight = 1;
    if (bonusRoleEntries.length > 0) {
      try {
        const member = await bot.helpers.getMember(guildId, BigInt(userId));
        for (const bonus of bonusRoleEntries) {
          if (member.roles.includes(BigInt(bonus.roleId))) {
            weight += bonus.extraEntries;
          }
        }
      } catch {
        // member fetch failed — fall back to base weight
      }
    }
    for (let i = 0; i < weight; i++) pool.push(userId);
  }

  const winners = new Set<string>();
  const maxAttempts = pool.length * 4; // guard against pathological loops
  let attempts = 0;
  while (winners.size < Math.min(count, entrantIds.length) && attempts < maxAttempts) {
    const pick = pool[Math.floor(Math.random() * pool.length)];
    winners.add(pick);
    attempts++;
  }

  return [...winners];
}

/** Called on a scheduler tick to end any giveaway whose endsAt has passed. */
export async function endDueGiveaways(bot: AppealyBot) {
  const due = await db
    .select()
    .from(schema.giveaways)
    .where(and(eq(schema.giveaways.status, "running"), sql`${schema.giveaways.endsAt} <= now()`));

  for (const giveaway of due) {
    try {
      await endGiveaway(bot, giveaway.id);
    } catch (err) {
      logger.error("Failed to auto-end giveaway", { giveawayId: giveaway.id, error: String(err) });
    }
  }
}
