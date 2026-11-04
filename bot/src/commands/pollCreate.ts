// bot/src/commands/pollCreate.ts
//
// /poll <channel> <question> <closes> <option1..option9> [multiselect] — instant poll
// creation and publish, alongside the dashboard's schedule-for-later flow
// (services/pollService.ts + polls REST routes). This command creates AND
// immediately publishes; scheduling is dashboard-only since Discord slash
// commands don't have a clean way to collect 2-9 options plus a datetime
// without exceeding the 25-option command-option limit awkwardly.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes, ChannelTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { publishPoll } from "../services/pollService.ts";
import { awaitReply } from "../services/pendingPrompts.ts";
import { parseWhen, toNativePollHours } from "../../../shared/lib/when.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

const MAX_OPTIONS = 9;

/**
 * How long the bot waits for a timezone to be picked when the close time
 * names an ambiguous one.
 *
 * Two minutes, against Discord's fifteen-minute deferred-interaction window,
 * so the ephemeral reply is still editable when the wait gives up and can say
 * what happened instead of silently expiring.
 */
const PROMPT_TIMEOUT_MS = 120_000;

export const definition: CreateApplicationCommand = {
  name: "poll",
  description: "Create and publish a poll",
  descriptionLocalizations: { ja: "投票を作成して公開します" },
  type: ApplicationCommandTypes.ChatInput,
  options: [
    // Text and announcement channels only: anywhere else, publishing fails.
    { name: "channel", description: "Channel to post the poll in", descriptionLocalizations: { ja: "投票を投稿するチャンネル" }, type: ApplicationCommandOptionTypes.Channel, required: true, channelTypes: [ChannelTypes.GuildText, ChannelTypes.GuildAnnouncement] },
    { name: "question", description: "The poll question", descriptionLocalizations: { ja: "投票の質問" }, type: ApplicationCommandOptionTypes.String, required: true },
    // Third so it's asked for before the answers. Free text, because "1h 20m",
    // "10 hours 50 minutes" and "july 10 3pm EST" don't fit a number option;
    // shared/lib/when.ts reads it.
    { name: "closes", description: "When it closes: 1h 20m, 2 days, or july 10 3pm EST (UTC without a timezone)", descriptionLocalizations: { ja: "締め切り: 1h 20m、2 days、july 10 3pm JST など（タイムゾーンなしは UTC）" }, type: ApplicationCommandOptionTypes.String, required: true, maxLength: 100 },
    { name: "option1", description: "Answer option 1", descriptionLocalizations: { ja: "選択肢 1" }, type: ApplicationCommandOptionTypes.String, required: true },
    { name: "option2", description: "Answer option 2", descriptionLocalizations: { ja: "選択肢 2" }, type: ApplicationCommandOptionTypes.String, required: true },
    { name: "option3", description: "Answer option 3", descriptionLocalizations: { ja: "選択肢 3" }, type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option4", description: "Answer option 4", descriptionLocalizations: { ja: "選択肢 4" }, type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option5", description: "Answer option 5", descriptionLocalizations: { ja: "選択肢 5" }, type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option6", description: "Answer option 6", descriptionLocalizations: { ja: "選択肢 6" }, type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option7", description: "Answer option 7", descriptionLocalizations: { ja: "選択肢 7" }, type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option8", description: "Answer option 8", descriptionLocalizations: { ja: "選択肢 8" }, type: ApplicationCommandOptionTypes.String, required: false },
    { name: "option9", description: "Answer option 9", descriptionLocalizations: { ja: "選択肢 9" }, type: ApplicationCommandOptionTypes.String, required: false },
    { name: "multiselect", description: "Allow voters to pick more than one option", descriptionLocalizations: { ja: "複数選択を許可します" }, type: ApplicationCommandOptionTypes.Boolean, required: false },
    {
      name: "engine",
      description: "Discord's built-in poll (default), or Appealy's legacy embed",
      descriptionLocalizations: { ja: "Discord 標準の投票（既定）、または Appealy の従来型の埋め込み" },
      type: ApplicationCommandOptionTypes.String,
      required: false,
      choices: [
        { name: "Discord poll (recommended)", value: "native" },
        { name: "Legacy embed (results in SQL)", value: "legacy" },
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

  // Appealy does the posting, so without this anyone could have it post where
  // they can't themselves: announcements, a staff channel. Checked against the
  // asker's own permissions in that channel, which Discord works out (roles and
  // the channel's overwrites included) and sends with the channel option. Create
  // Polls applies to the embed style too: a server that switched polls off
  // shouldn't find them back on through a bot.
  const perms = askerPermissionsIn(interaction, channelId);
  if (!perms) {
    return respond(bot, interaction, `I couldn't check your permissions in <#${channelId}>, so I won't post there.`);
  }
  if (!perms.has("VIEW_CHANNEL") || !perms.has("SEND_MESSAGES")) {
    return respond(bot, interaction, `You can't post in <#${channelId}>, so I won't post a poll there for you.`);
  }
  if (!perms.has("SEND_POLLS")) {
    return respond(bot, interaction, `You don't have permission to create polls in <#${channelId}>.`);
  }

  // A command option since 2026-11-03. The bot used to ask in the channel and
  // read the typed answer, which needed the Message Content intent.
  const closes = String(opts.closes ?? "");
  let when = parseWhen(closes, new Date());

  // A timezone that names more than one place is a question, not a rejection.
  // The parser refuses to guess between India, Ireland and Israel; this asks,
  // in the private reply, and the pick comes back through
  // interactions/selects/timezonePick.ts.
  if (!when.ok && when.ambiguity) {
    const { phrase, body, choices } = when.ambiguity;
    const promptChannel = interaction.channelId ?? channelId;
    // Waiting before the menu is shown, so even an instant pick finds a waiter.
    const answer = awaitReply(promptChannel, author.id, PROMPT_TIMEOUT_MS);

    await finish(bot, interaction, {
      content: `\`${phrase}\` could mean more than one place. Which did you mean?`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              // The asker's id, so a stranger clicking is a no-op.
              customId: encodeCustomId("tz", "pick", author.id.toString()),
              placeholder: "Pick a timezone",
              minValues: 1,
              maxValues: 1,
              // Discord caps a select at 25; no ambiguity here comes close,
              // but a country list is data rather than a constant.
              options: choices.slice(0, 25).map((c) => ({
                label: c.label.slice(0, 100),
                value: c.value.slice(0, 100),
              })),
            },
          ],
        },
      ],
    });

    const picked = await answer;
    if (picked === null) {
      return finish(bot, interaction, { content: "You didn't pick a timezone in time, so nothing was posted.", components: [] });
    }

    // Re-parsed rather than patched: the chosen value is a zone the parser
    // reads like any other, so the answer goes through the same grammar and
    // the same daylight-saving handling as one that was typed outright.
    when = parseWhen(`${body} ${picked}`, new Date());
  }

  if (!when.ok) {
    return respond(bot, interaction, `${when.reason}\n\nNothing was posted. Run \`/poll\` again.`);
  }

  const closesAt = when.at;
  // Named so the confirmation can say which reading was used. "3pm EST" and
  // "3pm" differ by five hours, and the author should see which they got.
  const zoneNote = when.zone ? ` (read as ${when.zone})` : "";

  if (engine === "native") {
    const native = toNativePollHours(closesAt, new Date());
    if (!native) {
      const why =
        "A Discord poll can run for at most 32 days. Either pick a sooner time, or " +
        "re-run with `engine: Legacy embed`, which has no such limit.";
      return respond(bot, interaction, why);
    }
    // Discord takes whole hours, so the poll is opened for the hours rounded
    // up and closesAt keeps the minute asked for: the scheduler ends it early
    // through Discord's End Poll (closeDuePolls in core/scheduler.ts).
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
  await respond(
    bot,
    interaction,
    `Poll posted in <#${channelId}>, closing <t:${unix(closesAt)}:F> (<t:${unix(closesAt)}:R>)${zoneNote}.`,
  );
}

/**
 * The asker's permissions in a channel picked in a command option, or null if
 * Discord didn't send them. Resolved options arrive as a Collection keyed by
 * bigint, or as a plain object keyed by string, depending on the path; see
 * resolveAttachment in importAppy.ts for the same care.
 */
function askerPermissionsIn(
  interaction: Interaction,
  channelId: bigint,
): { has(permission: "VIEW_CHANNEL" | "SEND_MESSAGES" | "SEND_POLLS"): boolean } | null {
  type Resolved = { permissions?: { has(permission: string): boolean } };
  const channels = interaction.data?.resolved?.channels as
    | Map<unknown, Resolved>
    | Record<string, Resolved>
    | undefined;
  const channel = channels instanceof Map
    ? channels.get(channelId) ?? channels.get(String(channelId))
    : channels?.[String(channelId)];
  return channel?.permissions ?? null;
}

/** Discord timestamp markup takes whole seconds. */
function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

// Ephemeral flag lives on the deferral. Clears the timezone menu, if one was
// shown, along with whatever was there before.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, { content, components: [] });
}
