// bot/src/services/pollService.ts
//
// Shared poll rendering + lifecycle logic used by both the interaction
// handler (live vote-count refresh) and the scheduler (publishing polls
// created via the dashboard at their scheduled time).

import { eq, and, sql, lte } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { logger } from "../utils/logger.ts";

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

export async function publishPoll(bot: AppealyBot, pollId: string) {
  const poll = await db.query.polls.findFirst({ where: eq(schema.polls.id, pollId) });
  if (!poll) return;

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
