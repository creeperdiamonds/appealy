// bot/src/commands/giveaway.ts
// /giveaway create|end|reroll — subcommand group for giveaway management.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { Interaction, CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { publishGiveaway, endGiveaway } from "../services/giveawayService.ts";

const EPHEMERAL = 64;
const ADMINISTRATOR = 0x8n;

export const definition: CreateApplicationCommand = {
  name: "giveaway",
  description: "Manage giveaways",
  type: ApplicationCommandTypes.ChatInput,
  defaultMemberPermissions: ADMINISTRATOR.toString(),
  options: [
    {
      name: "create",
      description: "Create and start a giveaway",
      type: ApplicationCommandOptionTypes.SubCommand,
      options: [
        { name: "channel", description: "Channel to post the giveaway in", type: ApplicationCommandOptionTypes.Channel, required: true },
        { name: "prize", description: "What's being given away", type: ApplicationCommandOptionTypes.String, required: true },
        { name: "duration_minutes", description: "How long the giveaway runs, in minutes", type: ApplicationCommandOptionTypes.Integer, required: true, minValue: 1 },
        { name: "winners", description: "Number of winners (default 1)", type: ApplicationCommandOptionTypes.Integer, required: false, minValue: 1, maxValue: 20 },
      ],
    },
    {
      name: "end",
      description: "End a giveaway early",
      type: ApplicationCommandOptionTypes.SubCommand,
      options: [{ name: "giveaway_id", description: "The giveaway ID", type: ApplicationCommandOptionTypes.String, required: true }],
    },
    {
      name: "reroll",
      description: "Reroll winner(s) for an ended giveaway",
      type: ApplicationCommandOptionTypes.SubCommand,
      options: [{ name: "giveaway_id", description: "The giveaway ID", type: ApplicationCommandOptionTypes.String, required: true }],
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const author = interaction.member?.user ?? interaction.user;
  if (!guildId || !author) return;

  const sub = interaction.data?.options?.[0];
  if (!sub) return;

  const opts = Object.fromEntries((sub.options ?? []).map((o) => [o.name, o.value]));

  if (sub.name === "create") {
    const channelId = BigInt(String(opts.channel));
    const prize = String(opts.prize);
    const durationMinutes = Number(opts.duration_minutes);
    const winnerCount = opts.winners ? Number(opts.winners) : 1;

    const endsAt = new Date(Date.now() + durationMinutes * 60_000);

    const [giveaway] = await db
      .insert(schema.giveaways)
      .values({ guildId, channelId, prize, winnerCount, endsAt, hostId: author.id, status: "draft" })
      .returning();

    await publishGiveaway(bot, giveaway.id);
    return respond(bot, interaction, `Giveaway for **${prize}** started in <#${channelId}>, ending <t:${Math.floor(endsAt.getTime() / 1000)}:R>.`);
  }

  if (sub.name === "end") {
    const giveawayId = String(opts.giveaway_id);
    const giveaway = await db.query.giveaways.findFirst({ where: eq(schema.giveaways.id, giveawayId) });
    if (!giveaway || giveaway.guildId !== guildId) return respond(bot, interaction, "Giveaway not found.");
    if (giveaway.status !== "running") return respond(bot, interaction, "That giveaway isn't currently running.");

    const winners = await endGiveaway(bot, giveawayId);
    return respond(
      bot,
      interaction,
      winners.length > 0 ? `Giveaway ended. Winner(s): ${winners.map((w) => `<@${w}>`).join(", ")}` : "Giveaway ended with no valid entries.",
    );
  }

  if (sub.name === "reroll") {
    const giveawayId = String(opts.giveaway_id);
    const giveaway = await db.query.giveaways.findFirst({ where: eq(schema.giveaways.id, giveawayId) });
    if (!giveaway || giveaway.guildId !== guildId) return respond(bot, interaction, "Giveaway not found.");
    if (giveaway.status !== "ended") return respond(bot, interaction, "That giveaway hasn't ended yet.");

    const winners = await endGiveaway(bot, giveawayId, true);
    return respond(
      bot,
      interaction,
      winners.length > 0 ? `Rerolled. New winner(s): ${winners.map((w) => `<@${w}>`).join(", ")}` : "No additional eligible entrants to reroll from.",
    );
  }
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
