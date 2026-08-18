// bot/src/interactions/buttons/giveawayEnter.ts

import { eq, and } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { checkEntryEligibility, renderGiveawayEmbed } from "../../services/giveawayService.ts";
import { checkAndConsumeDailyCap, rateLimitDeniedMessage } from "../../services/rateLimitService.ts";

const EPHEMERAL = 64;

const REASON_MESSAGES: Record<string, string> = {
  missing_required_role: "You don't have the required role to enter this giveaway.",
  has_blacklisted_role: "You're not eligible to enter this giveaway.",
  giveaway_ended: "This giveaway has already ended.",
  already_entered: "You've already entered this giveaway. Good luck!",
};

export async function handleGiveawayEnterButton(
  bot: AppealyBot,
  interaction: Interaction,
  giveawayId: string,
) {
  const guildId = interaction.guildId;
  const entrant = interaction.member?.user ?? interaction.user;
  if (!guildId || !entrant) return;

  const giveaway = await db.query.giveaways.findFirst({ where: eq(schema.giveaways.id, giveawayId) });
  if (!giveaway) return respond(bot, interaction, "This giveaway no longer exists.");

  const alreadyEntered = await db.query.giveawayEntries.findFirst({
    where: and(eq(schema.giveawayEntries.giveawayId, giveawayId), eq(schema.giveawayEntries.userId, entrant.id)),
  });

  const check = checkEntryEligibility(
    giveaway,
    (interaction.member?.roles ?? []).map(String),
    Boolean(alreadyEntered),
  );

  if (!check.allowed) {
    return respond(bot, interaction, REASON_MESSAGES[check.reason ?? ""] ?? "You can't enter this giveaway.");
  }

  // Rate-limited after the free eligibility/duplicate checks above, so a
  // rejected duplicate-entry attempt never consumes quota — only entries
  // that actually get persisted count against the daily cap.
  const rateLimit = await checkAndConsumeDailyCap(guildId, "giveawayEntriesPerDay");
  if (!rateLimit.allowed) {
    return respond(bot, interaction, rateLimitDeniedMessage(rateLimit, "giveaway entries processed today"));
  }

  await db.insert(schema.giveawayEntries).values({ giveawayId, userId: entrant.id });

  if (giveaway.messageId) {
    const refreshed = await db.query.giveaways.findFirst({ where: eq(schema.giveaways.id, giveawayId) });
    if (refreshed) {
      const embed = await renderGiveawayEmbed(refreshed);
      try {
        await bot.helpers.editMessage(giveaway.channelId, giveaway.messageId, { embeds: [embed] });
      } catch {
        // non-fatal — entry is recorded even if the live count display lags
      }
    }
  }

  await respond(bot, interaction, "You're entered! Good luck 🎉");
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
