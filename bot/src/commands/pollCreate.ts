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
import { defer, finish } from "../utils/interactionResponse.ts";

const MAX_OPTIONS = 9;

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

  const [poll] = await db
    .insert(schema.polls)
    .values({
      guildId,
      channelId,
      question,
      options,
      allowMultiselect: multiselect,
      status: "draft",
      createdBy: author.id,
    })
    .returning();

  await publishPoll(bot, poll.id);

  await respond(bot, interaction, `Poll posted in <#${channelId}>.`);
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
