// bot/src/interactions/selects/votePerk.ts
//
// Spends a top.gg vote on the perk picked from /vote's menu, for the server
// the menu was opened in.
//
// Spending is "whoever deletes the vote key gets it": DEL reports how many
// keys it removed, so of two clicks (or two servers' menus open at once) only
// one sees 1, and one vote can't buy two perks.

import type { AppealyBot, AppealyInteraction as Interaction } from "../../core/client.ts";
import { withRedis } from "../../core/redis.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";
import { logger } from "../../utils/logger.ts";
import { findPerk, VOTE_PERK_SECONDS, voteKey, votePerkKey } from "../../../../shared/schema/votePerks.ts";
import { voteUrl } from "../../commands/vote.ts";

export async function handleVotePerk(bot: AppealyBot, interaction: Interaction, voterId: string) {
  const guildId = interaction.guildId;
  const clicker = interaction.member?.user ?? interaction.user;
  const perk = findPerk(interaction.data?.values?.[0] ?? "");
  if (!guildId || !clicker) return;

  await defer(bot, interaction, { ephemeral: true });

  if (clicker.id.toString() !== voterId) {
    return finish(bot, interaction, "That menu is someone else's. Run `/vote` to get your own.");
  }
  if (!perk) return finish(bot, interaction, "That perk doesn't exist any more. Run `/vote` again.");

  const until = Date.now() + VOTE_PERK_SECONDS * 1000;
  const spent = await withRedis(async (r) => {
    if ((await r.del(voteKey(voterId))) !== 1) return "none" as const;
    await r.set(
      votePerkKey(guildId.toString()),
      JSON.stringify({ perk: perk.id, userId: voterId, until }),
      { ex: VOTE_PERK_SECONDS },
    );
    return "ok" as const;
  }, "error" as const);

  if (spent === "error") {
    return finish(bot, interaction, "Couldn't save that just now. Try again in a moment.");
  }
  if (spent === "none") {
    return finish(
      bot,
      interaction,
      `You don't have a vote to spend. It's already been used, or it ran out. You can vote again here once top.gg lets you: ${voteUrl()}`,
    );
  }

  logger.info("Vote perk applied", { guildId: guildId.toString(), userId: voterId, perk: perk.id });
  return finish(
    bot,
    interaction,
    `Done! This server has **${perk.label}** until <t:${Math.floor(until / 1000)}:f>. Thanks for voting!`,
  );
}
