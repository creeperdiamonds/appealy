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
import { describeDiscordError } from "../utils/discordError.ts";

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

/** The message that was clicked, when there is one. */
export type Clicked = { id?: bigint; embeds?: unknown[] } | undefined | null;

/**
 * The review post's embed, ready to reuse, or null if it can't be had.
 *
 * A button clicked ON the review post (Accept, Deny, a vote) carries the post
 * itself, so nothing is fetched. Only a decision made somewhere else (an
 * outcome's confirm step, the applicant withdrawing) reads it back, and
 * reading needs Read Message History in the channel, which posting and editing
 * don't: servers that left it off saw every one of those reads fail.
 */
export async function reviewPostEmbed(
  bot: AppealyBot,
  channelId: bigint,
  messageId: bigint,
  submissionId: string,
  clicked?: Clicked,
): Promise<Embed | null> {
  if (clicked?.id === messageId && clicked.embeds?.[0]) return resendableEmbed(clicked.embeds[0] as Embed);
  try {
    const post = await bot.helpers.getMessage(channelId, messageId);
    return resendableEmbed(post.embeds?.[0] as Embed | undefined);
  } catch (err) {
    logger.warn("Failed to read the review post", { submissionId, ...discordFailure(err) });
    return null;
  }
}

/**
 * Marks the review post decided: recoloured, a new footer, and no more
 * buttons. Returns the embed it wrote, for copying to an outcome channel.
 *
 * When the post can't be read, it is still closed: the buttons come off and
 * a line above the untouched embed says what was decided. A post that keeps
 * Accept and Deny after a decision looks like nobody acted on it.
 */
export async function markReviewPost(
  bot: AppealyBot,
  channelId: bigint,
  messageId: bigint,
  submissionId: string,
  decision: { color: number; footer: string },
  clicked?: Clicked,
): Promise<Embed | null> {
  const embed = await reviewPostEmbed(bot, channelId, messageId, submissionId, clicked);
  const decided = embed ? { ...embed, color: decision.color, footer: { text: decision.footer } } : null;
  const edit = decided
    ? { embeds: [decided], components: [] }
    : { content: `**${decision.footer.split(" • ")[0]}**`, components: [], allowedMentions: { parse: [] } };
  try {
    await bot.helpers.editMessage(channelId, messageId, edit as never);
  } catch (err) {
    logger.warn("Failed to mark the review post decided", { submissionId, ...discordFailure(err) });
  }
  return decided;
}

/** What Discord said, not just "Failed to send request to discord". */
function discordFailure(err: unknown) {
  const info = describeDiscordError(err);
  return { status: info.status, code: info.code, error: info.message };
}
