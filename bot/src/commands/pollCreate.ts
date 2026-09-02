// bot/src/commands/pollCreate.ts
//
// /poll <channel> <question> <option1..option9> [multiselect] — instant poll
// creation and publish, alongside the dashboard's schedule-for-later flow
// (services/pollService.ts + polls REST routes). This command creates AND
// immediately publishes; scheduling is dashboard-only since Discord slash
// commands don't have a clean way to collect 2-9 options plus a datetime
// without exceeding the 25-option command-option limit awkwardly.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { publishPoll } from "../services/pollService.ts";
import { awaitReply } from "../services/pendingPrompts.ts";
import { parseWhen, toNativePollHours } from "../../../shared/lib/when.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

const MAX_OPTIONS = 9;

/**
 * How long the bot waits for the close time to be typed.
 *
 * Two minutes, against Discord's fifteen-minute deferred-interaction window,
 * so the ephemeral reply is still editable when the wait gives up and can say
 * what happened instead of silently expiring.
 */
const PROMPT_TIMEOUT_MS = 120_000;

export const definition: CreateApplicationCommand = {
  name: "poll",
  description: "Create and publish a poll",
  type: ApplicationCommandTypes.ChatInput,
  options: [
    { name: "channel", description: "Channel to post the poll in", type: ApplicationCommandOptionTypes.Channel, required: true },
    { name: "question", description: "The poll question", type: ApplicationCommandOptionTypes.String, required: true },
    { name: "option1", description: "Answer option 1", type: ApplicationCommandOptionTypes.String, required: true },
    { name: "option2", description: "Answer option 2", type: ApplicationCommandOptionTypes.String, required: true },
    { name: "option3", description: "Answer option 3", type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option4", description: "Answer option 4", type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option5", description: "Answer option 5", type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option6", description: "Answer option 6", type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option7", description: "Answer option 7", type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option8", description: "Answer option 8", type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option9", description: "Answer option 9", type: ApplicationCommandOptionTypes.String, required: false },
    { name: "multiselect", description: "Allow voters to pick more than one option", type: ApplicationCommandOptionTypes.Boolean, required: false },
    {
      name: "engine",
      description: "Discord's built-in poll (default), or Appealy's legacy embed",
      type: ApplicationCommandOptionTypes.String,
      required: false,
      choices: [
        { name: "Discord poll (recommended)", value: "native" },
        { name: "Legacy embed (exact close time, results in SQL)", value: "legacy" },
      ],
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const author = interaction.member?.user ?? interaction.user;
  if (!guildId || !author) return;

  // The option-count check just below responds on its own failure path, so
  // defer has to land before it, not after the way it does in files whose
  // only guards ahead of any asynchronous work are silent: once any call
  // site below is converted to finish(), EVERY response path — including
  // this one — needs a deferral to edit, or the edit 404s against an
  // unacknowledged token. The insert and publishPoll() further down (which
  // posts the message and stores its id) are DB writes plus a REST call —
  // enough on their own to blow Discord's three-second first-response
  // window.
  await defer(bot, interaction, { ephemeral: true });

  const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
  const channelId = BigInt(String(opts.channel));
  const question = String(opts.question);
  const multiselect = Boolean(opts.multiselect ?? false);
  // Native unless asked otherwise. The column defaults the other way, for
  // rows that predate the choice — see the comment on polls.engine.
  const engine = opts.engine === "legacy" ? "legacy" as const : "native" as const;

  const options: { id: string; label: string }[] = [];
  for (let i = 1; i <= MAX_OPTIONS; i++) {
    const val = opts[`option${i}`];
    if (typeof val === "string" && val.trim().length > 0) {
      options.push({ id: crypto.randomUUID(), label: val.trim() });
    }
  }

  if (options.length < 2) {
    return respond(bot, interaction, "A poll needs at least 2 options.");
  }

  // Asked for rather than taken as an option. A slash-command option can hold
  // "2" hours; it cannot hold "1h 20m", "10 hours 50 minutes" or "july 10"
  // without a format nobody remembers. So the bot asks in the channel and
  // reads the answer — see services/pendingPrompts.ts.
  const promptChannel = interaction.channelId ?? channelId;
  const prompt = await bot.helpers.sendMessage(promptChannel, {
    content:
      `<@${author.id}> — when should this poll close?\n` +
      "Reply with a duration like `1h 20m` or `10 hours 50 minutes`, or a date like " +
      "`july 10` or `2026-07-10 14:30`. Dates are read as UTC and echoed back so you can check them.",
  });

  const reply = await awaitReply(promptChannel, author.id, PROMPT_TIMEOUT_MS);

  if (reply === null) {
    await editPrompt(bot, promptChannel, prompt.id, "No close time given in time — poll cancelled.");
    return respond(bot, interaction, "You didn't answer in time, so nothing was posted. Run `/poll` again.");
  }

  const when = parseWhen(reply, new Date());
  if (!when.ok) {
    await editPrompt(bot, promptChannel, prompt.id, `Poll cancelled — ${when.reason}`);
    return respond(bot, interaction, `${when.reason}\n\nNothing was posted. Run \`/poll\` again.`);
  }

  let closesAt = when.at;
  let roundingNote = "";

  if (engine === "native") {
    const native = toNativePollHours(closesAt, new Date());
    if (!native) {
      const why =
        "A Discord poll can run for at most 32 days. Either pick a sooner time, or " +
        "re-run with `engine: Legacy embed`, which has no such limit.";
      await editPrompt(bot, promptChannel, prompt.id, `Poll cancelled — ${why}`);
      return respond(bot, interaction, why);
    }
    if (native.rounded) {
      // Said out loud rather than applied quietly. Discord takes whole hours,
      // so the poll will not close at the minute that was asked for, and
      // finding that out from the poll itself would be worse.
      const exact = closesAt;
      closesAt = new Date(Date.now() + native.hours * 3_600_000);
      roundingNote =
        `\n\nDiscord polls run in whole hours, so this closes at <t:${unix(closesAt)}:t> ` +
        `rather than <t:${unix(exact)}:t>. Use \`engine: Legacy embed\` for an exact time.`;
    }
  }

  const [poll] = await db
    .insert(schema.polls)
    .values({
      guildId,
      channelId,
      question,
      options,
      allowMultiselect: multiselect,
      engine,
      closesAt,
      status: "draft",
      createdBy: author.id,
    })
    .returning();

  await publishPoll(bot, poll.id);

  // <t:...:F> renders in each reader's own timezone, which is the honest way
  // to confirm a time parsed as UTC from text that named no zone.
  await editPrompt(
    bot,
    promptChannel,
    prompt.id,
    `Poll posted in <#${channelId}> — closes <t:${unix(closesAt)}:F> (<t:${unix(closesAt)}:R>).`,
  );

  await respond(
    bot,
    interaction,
    `Poll posted in <#${channelId}>, closing <t:${unix(closesAt)}:R>.${roundingNote}`,
  );
}

/** Discord timestamp markup takes whole seconds. */
function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/**
 * Rewrites the question the bot asked into what came of it, so the channel is
 * left with one message that reads as a result rather than a dangling
 * question. Failure here is cosmetic and must not lose a posted poll.
 */
async function editPrompt(bot: AppealyBot, channelId: bigint, messageId: bigint, content: string) {
  try {
    await bot.helpers.editMessage(channelId, messageId, { content });
  } catch {
    // The message may have been deleted by a moderator mid-prompt.
  }
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
