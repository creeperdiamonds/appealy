// bot/src/services/reviewPost.ts
//
// Reading a submission's review post back so a decision can be written onto
// it (and copied to an accepted/denied channel).
//
// Two traps this exists to avoid, both of which had every accept, deny and
// withdraw since at least 2026-09-21 failing to update the post:
//
// 1. Discordeno hands embeds back *transformed*: timestamp is a number of
//    milliseconds (transformers/embed.js), and helpers.editMessage /
//    sendMessage send what they're given without reversing that. Discord
//    wants an ISO 8601 string and rejects the whole request, so the post
//    kept its Accept/Deny buttons and looked undecided.
// 2. interaction.message is whatever message was clicked. For a decision
//    made through a confirmation step that's the ephemeral confirm message,
//    not the review post, so copying its embed would have replaced the
//    applicant's answers with an empty card. The post is fetched instead.

import type { AppealyBot } from "../core/client.ts";
import { logger } from "../utils/logger.ts";

type Embed = Record<string, unknown>;

/**
 * An embed as Discordeno returns it, made safe to send again: the timestamp
 * back to ISO 8601, and the fields Discord fills in itself dropped.
 */
export function resendableEmbed(embed: Embed | undefined | null): Embed {
  if (!embed) return {};
  const { type: _type, video: _video, provider: _provider, ...rest } = embed;
  const out: Embed = { ...rest };
  if (typeof out.timestamp === "number") out.timestamp = new Date(out.timestamp).toISOString();
  return out;
}

/** The review post's embed, ready to reuse, or null if the post can't be read. */
export async function reviewPostEmbed(
  bot: AppealyBot,
  channelId: bigint,
  messageId: bigint,
  submissionId: string,
): Promise<Embed | null> {
  try {
    const post = await bot.helpers.getMessage(channelId, messageId);
    return resendableEmbed(post.embeds?.[0] as Embed | undefined);
  } catch (err) {
    logger.warn("Failed to read the review post", { submissionId, error: String(err) });
    return null;
  }
}

/**
 * Marks the review post decided: recoloured, a new footer, and no more
 * buttons. Returns the embed it wrote, for copying to an outcome channel.
 */
export async function markReviewPost(
  bot: AppealyBot,
  channelId: bigint,
  messageId: bigint,
  submissionId: string,
  decision: { color: number; footer: string },
): Promise<Embed | null> {
  const embed = await reviewPostEmbed(bot, channelId, messageId, submissionId);
  if (!embed) return null;
  const decided = { ...embed, color: decision.color, footer: { text: decision.footer } };
  try {
    await bot.helpers.editMessage(channelId, messageId, { embeds: [decided], components: [] } as never);
  } catch (err) {
    logger.warn("Failed to mark the review post decided", { submissionId, error: String(err) });
  }
  return decided;
}
