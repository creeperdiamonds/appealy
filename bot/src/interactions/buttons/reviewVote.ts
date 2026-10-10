// bot/src/interactions/buttons/reviewVote.ts
//
// 👍 / 👎 on a pending submission's review post. Reviewers only, one vote
// each: clicking your own vote again takes it back, clicking the other one
// switches. The post's button counts and its "Staff votes" field (who voted
// which way) are redrawn after every vote, and the field stays on the post
// once it's decided, as the record of how staff leaned.
//
// Advisory: Accept and Deny don't look at votes. Teams decide how to use them.

import { and, eq } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { canReviewForm } from "../../services/permissionService.ts";
import { reviewButtonRow, withVotesField } from "../../services/reviewButtons.ts";
import { reviewPostEmbed } from "../../services/reviewPost.ts";
import { logger } from "../../utils/logger.ts";
import { describeDiscordError } from "../../utils/discordError.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleReviewVote(bot: AppealyBot, interaction: Interaction, submissionId: string, choice: string) {
  const guildId = interaction.guildId;
  const voter = interaction.member?.user ?? interaction.user;
  if (!guildId || !voter || (choice !== "up" && choice !== "down")) return;

  await defer(bot, interaction, { ephemeral: true });

  const submission = await db.query.submissions.findFirst({
    where: eq(schema.submissions.id, submissionId),
    with: { form: true },
  });
  if (!submission) return finish(bot, interaction, "This submission no longer exists.");
  if (submission.status !== "pending") {
    return finish(bot, interaction, `This was already marked **${submission.status}**, so voting is closed.`);
  }
  const allowed = await canReviewForm(
    guildId,
    submission.formId,
    voter.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions?.bitfield ?? 0n,
  );
  if (!allowed) return finish(bot, interaction, "Only reviewers can vote on this.");

  const key = and(eq(schema.submissionVotes.submissionId, submissionId), eq(schema.submissionVotes.voterId, voter.id));
  const mine = await db.query.submissionVotes.findFirst({ where: key });
  let said: string;
  if (mine?.vote === choice) {
    await db.delete(schema.submissionVotes).where(key);
    said = "Vote removed.";
  } else if (mine) {
    await db.update(schema.submissionVotes).set({ vote: choice, createdAt: new Date() }).where(key);
    said = `Changed your vote to ${choice === "up" ? "👍" : "👎"}.`;
  } else {
    await db.insert(schema.submissionVotes).values({ submissionId, voterId: voter.id, vote: choice });
    said = `You voted ${choice === "up" ? "👍" : "👎"}.`;
  }

  const votes = await db
    .select({ voterId: schema.submissionVotes.voterId, vote: schema.submissionVotes.vote })
    .from(schema.submissionVotes)
    .where(eq(schema.submissionVotes.submissionId, submissionId))
    .orderBy(schema.submissionVotes.createdAt);
  const counts = { up: votes.filter((v) => v.vote === "up").length, down: votes.filter((v) => v.vote === "down").length };

  if (submission.logMessageId) {
    // The vote was clicked on the review post, so it's at hand: no read needed.
    const embed = await reviewPostEmbed(bot, submission.form.logChannelId, submission.logMessageId, submission.id, interaction.message);
    try {
      await bot.helpers.editMessage(submission.form.logChannelId, submission.logMessageId, {
        ...(embed
          ? { embeds: [{ ...embed, fields: withVotesField(embed.fields as { name: string; value: string }[] | undefined, votes) }] }
          : {}),
        components: reviewButtonRow(submission.id, counts),
        // The voters are named in the field, but nobody gets pinged by it.
        allowedMentions: { parse: [] },
      } as never);
    } catch (err) {
      const info = describeDiscordError(err);
      logger.warn("Failed to redraw votes on the review post", { submissionId, status: info.status, code: info.code, error: info.message });
    }
  }

  return finish(bot, interaction, `${said} Now ${counts.up} 👍 · ${counts.down} 👎.`);
}
