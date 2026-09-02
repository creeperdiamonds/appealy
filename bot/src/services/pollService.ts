// bot/src/services/pollService.ts
//
// Shared poll rendering + lifecycle logic used by both the interaction
// handler (live vote-count refresh) and the scheduler (publishing polls
// created via the dashboard at their scheduled time).

import { eq, and, sql, lte } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { toNativePollHours } from "../../../shared/lib/when.ts";
import { logger } from "../utils/logger.ts";

/** Discord's cap on answers in a native poll. Appealy's own cap is 9. */
export const NATIVE_POLL_MAX_ANSWERS = 10;

export async function renderPollEmbed(poll: typeof schema.polls.$inferSelect) {
  const voteCounts = await db
    .select({
      optionId: schema.pollVotes.optionId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.pollVotes)
    .where(eq(schema.pollVotes.pollId, poll.id))
    .groupBy(schema.pollVotes.optionId);

  const countMap = Object.fromEntries(voteCounts.map((v) => [v.optionId, v.count]));
  const totalVotes = voteCounts.reduce((sum, v) => sum + v.count, 0);

  const description = poll.options
    .map((opt) => {
      const count = countMap[opt.id] ?? 0;
      const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
      const barLength = Math.round(pct / 5);
      const bar = "█".repeat(barLength) + "░".repeat(20 - barLength);
      return `${opt.emoji ?? "•"} **${opt.label}**\n${bar} ${count} (${pct}%)`;
    })
    .join("\n\n");

  return {
    title: poll.question,
    description,
    color: 0x5865f2,
    footer: {
      text: `${totalVotes} vote${totalVotes === 1 ? "" : "s"} total${
        poll.closesAt ? ` • Closes ${poll.closesAt.toISOString()}` : ""
      }`,
    },
  };
}

/**
 * Hands the poll to Discord's own poll system.
 *
 * What this buys is the thing the embed was imitating: real radio buttons, a
 * Vote button, a live countdown, Show results, and vote storage on Discord's
 * side rather than ours.
 *
 * What it costs is written into the shape of the call. `duration` is whole
 * hours, so closesAt has already been rounded UP by the caller — closing a
 * poll before the time its author announced is the worse error. And nothing
 * writes poll_votes for a native poll: Discord holds those, readable through
 * getPollAnswerVoters on the message, never with SQL.
 */
async function publishNativePoll(
  bot: AppealyBot,
  poll: typeof schema.polls.$inferSelect,
  durationHours: number,
) {
  const message = await bot.helpers.sendMessage(poll.channelId, {
    poll: {
      question: { text: poll.question },
      answers: poll.options.slice(0, NATIVE_POLL_MAX_ANSWERS).map((o) => ({
        pollMedia: o.emoji ? { text: o.label, emoji: { name: o.emoji } } : { text: o.label },
      })),
      duration: durationHours,
      allowMultiselect: poll.allowMultiselect,
    },
  } as never);

  await db
    .update(schema.polls)
    .set({ status: "published", messageId: message.id })
    .where(eq(schema.polls.id, poll.id));

  logger.info("Native poll published", {
    pollId: poll.id,
    channelId: poll.channelId.toString(),
    durationHours,
  });
}

/**
 * Closes a poll early.
 *
 * Native polls end through Discord, which recounts and freezes them; there is
 * no equivalent for the legacy embed beyond marking the row, since its votes
 * are ours already.
 */
export async function closePoll(bot: AppealyBot, pollId: string) {
  const poll = await db.query.polls.findFirst({ where: eq(schema.polls.id, pollId) });
  if (!poll) return;

  if (poll.engine === "native" && poll.messageId) {
    try {
      // On bot.rest, not bot.helpers — the poll routes live on the REST
      // manager in Discordeno v20 and were never given helper wrappers.
      await bot.rest.endPoll(poll.channelId, poll.messageId);
    } catch (err) {
      // Already expired on Discord's side is the common case and not a
      // failure — the row still needs closing either way.
      logger.warn("endPoll failed; closing the row regardless", {
        pollId,
        error: String(err),
      });
    }
  }

  await db.update(schema.polls).set({ status: "closed" }).where(eq(schema.polls.id, pollId));
}

export async function publishPoll(bot: AppealyBot, pollId: string) {
  const poll = await db.query.polls.findFirst({ where: eq(schema.polls.id, pollId) });
  if (!poll) return;

  if (poll.engine === "native") {
    // closesAt is required for a native poll — Discord has no open-ended
    // one. A row without it means the dashboard scheduled a native poll and
    // left the close time unset, which cannot be published as native; fall
    // through to legacy rather than inventing a duration.
    const hours = poll.closesAt ? toNativePollHours(poll.closesAt, new Date()) : null;
    if (hours) {
      return await publishNativePoll(bot, poll, hours.hours);
    }
    logger.warn("Native poll has no usable close time; publishing it as legacy", {
      pollId,
      closesAt: poll.closesAt?.toISOString() ?? null,
    });
  }

  const embed = await renderPollEmbed(poll);
  const message = await bot.helpers.sendMessage(poll.channelId, {
    embeds: [embed],
    components: [
      {
        type: 1,
        components: [
          {
            type: 3, // string select acts as the vote mechanism
            customId: encodeCustomId("poll", "vote", poll.id),
            placeholder: "Cast your vote",
            minValues: 1,
            maxValues: poll.allowMultiselect ? poll.options.length : 1,
            options: poll.options.map((o) => ({
              label: o.label,
              value: o.id,
              emoji: o.emoji ? { name: o.emoji } : undefined,
            })),
          },
        ],
      },
    ],
  });

  await db
    .update(schema.polls)
    .set({ status: "published", messageId: message.id })
    .where(eq(schema.polls.id, pollId));

  logger.info("Poll published", { pollId, channelId: poll.channelId.toString() });
}

/** Called on a scheduler tick (see bot/src/core/scheduler.ts) to publish any
 * polls whose scheduledFor time has arrived. */
export async function publishDuePolls(bot: AppealyBot) {
  const due = await db
    .select()
    .from(schema.polls)
    .where(and(eq(schema.polls.status, "scheduled"), lte(schema.polls.scheduledFor, new Date())));

  for (const poll of due) {
    await publishPoll(bot, poll.id);
  }
}
