// bot/src/interactions/selects/pollVote.ts
//
// Handles votes cast via the select menu attached to a published poll
// message. Supports single or multi-select depending on poll config,
// and upserts votes so re-voting changes rather than duplicates a choice.

import { eq, and } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { renderPollEmbed } from "../../services/pollService.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handlePollVote(
  bot: AppealyBot,
  interaction: Interaction,
  pollId: string,
  _extra: string | undefined,
) {
  const voter = interaction.member?.user ?? interaction.user;
  if (!voter) return;

  // A poll lookup, a delete+insert transaction, then a re-render and
  // message edit to refresh the public vote counts — sequential enough to
  // risk the window, especially on a busy poll message.
  await defer(bot, interaction, { ephemeral: true });

  const poll = await db.query.polls.findFirst({ where: eq(schema.polls.id, pollId) });
  if (!poll || poll.status !== "published") {
    return respond(bot, interaction, "This poll is no longer accepting votes.");
  }
  if (poll.closesAt && poll.closesAt < new Date()) {
    return respond(bot, interaction, "This poll has closed.");
  }

  const chosenOptionIds = interaction.data?.values ?? [];

  await db.transaction(async (tx) => {
    // Clear previous votes from this user for this poll, then insert fresh
    // selections — simplest correct way to support both single and multi
    // select without diffing.
    await tx
      .delete(schema.pollVotes)
      .where(and(eq(schema.pollVotes.pollId, pollId), eq(schema.pollVotes.userId, voter.id)));

    if (chosenOptionIds.length > 0) {
      await tx.insert(schema.pollVotes).values(
        chosenOptionIds.map((optionId) => ({
          pollId,
          userId: voter.id,
          optionId,
        })),
      );
    }
  });

  // Refresh the public poll message with updated vote counts.
  if (poll.messageId) {
    const embed = await renderPollEmbed(poll);
    try {
      await bot.helpers.editMessage(poll.channelId, poll.messageId, { embeds: [embed] });
    } catch {
      // non-fatal — vote is recorded even if the live count display lags
    }
  }

  await respond(bot, interaction, "Your vote has been recorded.");
}

// Kept as a one-line wrapper rather than rewriting every call site: the
// ephemeral flag now lives on the deferral, so there is nothing left for
// this to decide.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
