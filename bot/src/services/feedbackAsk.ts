// bot/src/services/feedbackAsk.ts
//
// "Got 30 seconds?" on the private confirmation a moderator gets after
// Accept or Deny. Chosen over a button on the review message (2026-10-04
// mock-ups): it never adds anything to a channel or reaches an applicant,
// and it asks the people who actually use Appealy right after they've used
// it. Only the moderator sees it ("Only you can see this").
//
// Asked once per person per round, whatever they click, and never in a
// server that turned it off (dashboard, Help & support). Someone who already
// answered this round, on the dashboard or here, isn't asked. Answers land in
// the same feedback table as the dashboard's form, per person.

import { and, eq, gte } from "drizzle-orm";
import type { AppealyBot, AppealyInteraction as Interaction } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { logger } from "../utils/logger.ts";

/**
 * The current round. Change it to ask everyone again. Same idea as ROUND in
 * web/src/lib/feedback.ts (the dashboard banner); kept as its own value so
 * either can start a round without the other.
 */
export const FEEDBACK_ROUND = "2026-10-04";

const EPHEMERAL = 64;

export const QUESTIONS = [
  { id: "usedFor", label: "What do you use Appealy for?" },
  { id: "annoyance", label: "Most annoying thing about it right now?" },
  { id: "missing", label: "What did you expect and not find?" },
] as const;

/** Whether this moderator should see the ask now. Never throws: a failed check just doesn't ask. */
async function shouldAsk(guildId: bigint, userId: bigint): Promise<boolean> {
  try {
    const [setting, asked, answered] = await Promise.all([
      db.query.feedbackPromptSettings.findFirst({ where: eq(schema.feedbackPromptSettings.guildId, guildId) }),
      db.query.feedbackPrompts.findFirst({
        where: and(eq(schema.feedbackPrompts.userId, userId), eq(schema.feedbackPrompts.round, FEEDBACK_ROUND)),
      }),
      db.query.feedback.findFirst({
        where: and(eq(schema.feedback.authorId, userId), gte(schema.feedback.createdAt, new Date(FEEDBACK_ROUND))),
        columns: { id: true },
      }),
    ]);
    if (setting && !setting.enabled) return false;
    return !asked && !answered;
  } catch (err) {
    logger.warn("Couldn't check whether to ask for feedback", { error: String(err) });
    return false;
  }
}

/**
 * The confirmation, with the feedback ask under it when this moderator should
 * see it. The ask is recorded as shown before it's returned, so it can't
 * appear twice even if two reviews finish at once.
 */
export async function confirmationWithAsk(
  guildId: bigint | undefined,
  userId: bigint | undefined,
  content: string,
): Promise<{ content: string; components?: unknown[] }> {
  if (!guildId || !userId || !(await shouldAsk(guildId, userId))) return { content };
  try {
    const inserted = await db
      .insert(schema.feedbackPrompts)
      .values({ userId, round: FEEDBACK_ROUND })
      .onConflictDoNothing()
      .returning({ userId: schema.feedbackPrompts.userId });
    if (inserted.length === 0) return { content };
  } catch {
    return { content };
  }
  return {
    content: `${content}\n\n─────────────\nGot 30 seconds? Tell the developer how Appealy's working for you.`,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: "Give feedback", customId: encodeCustomId("feedback", "open", FEEDBACK_ROUND) },
          { type: 2, style: 2, label: "Not now", customId: encodeCustomId("feedback", "later", FEEDBACK_ROUND) },
        ],
      },
    ],
  };
}

/** "Give feedback": the three questions, as a pop-up. A modal must be the first response, so no defer. */
export async function openFeedbackModal(bot: AppealyBot, interaction: Interaction): Promise<void> {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9,
    data: {
      customId: encodeCustomId("feedback", "submit", FEEDBACK_ROUND),
      title: "Feedback for Appealy",
      components: QUESTIONS.map((q) => ({
        type: 1,
        components: [
          { type: 4, customId: q.id, label: q.label, style: 2, required: false, maxLength: 2000 },
        ],
      })),
    },
  });
}

/** "Not now": takes the ask off the confirmation, leaving the confirmation itself. */
export async function dismissFeedbackAsk(bot: AppealyBot, interaction: Interaction): Promise<void> {
  const content = (interaction.message as { content?: string } | undefined)?.content ?? "";
  const kept = content.split("\n\n─────────────")[0];
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 7, // update the message the button is on
    data: { content: kept || "Got it.", components: [] },
  });
}

/** The pop-up's answers: stored per person, then a private thank-you. */
export async function submitFeedback(bot: AppealyBot, interaction: Interaction): Promise<void> {
  const values: Record<string, string> = {};
  const rows = (interaction.data as { components?: { components?: { customId?: string; value?: string }[] }[] })
    ?.components ?? [];
  for (const row of rows) {
    for (const input of row.components ?? []) {
      if (input.customId) values[input.customId] = (input.value ?? "").trim().slice(0, 2000);
    }
  }
  const authorId = interaction.user?.id ?? interaction.member?.user?.id;
  const reply = (content: string) =>
    bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: { content, flags: EPHEMERAL },
    });
  if (!authorId) return void (await reply("Couldn't tell who sent that. Try the dashboard's feedback form instead."));
  if (!values.usedFor && !values.annoyance && !values.missing) {
    return void (await reply("Nothing was filled in, so nothing was sent."));
  }
  try {
    await db.insert(schema.feedback).values({
      authorId,
      usedFor: values.usedFor || null,
      annoyance: values.annoyance || null,
      missing: values.missing || null,
    });
  } catch (err) {
    logger.error("Couldn't store feedback from the Discord form", { error: String(err) });
    return void (await reply("Couldn't save that. Try again in a moment, or use the dashboard's feedback form."));
  }
  logger.info("Feedback received", { via: "discord", answered: Object.keys(values).filter((k) => values[k]) });
  await reply("Thank you! Every answer is read.");
}
