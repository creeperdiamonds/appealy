// bot/src/commands/giveaway.ts
// /giveaway create|end|reroll — subcommand group for giveaway management.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { publishGiveaway, endGiveaway } from "../services/giveawayService.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

const ADMINISTRATOR = 0x8n;

export const definition: CreateApplicationCommand = {
  name: "giveaway",
  description: "Manage giveaways",
  type: ApplicationCommandTypes.ChatInput,
  // Discordeno takes permission NAMES here, not a bitfield string. The
  // old form type-checked against nothing and would have registered the
  // command with a permission value Discord could not parse.
  defaultMemberPermissions: ["ADMINISTRATOR"],
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

  // Every branch below does at least one DB round trip (create/end/reroll
  // all touch schema.giveaways, and create/end also call out to Discord via
  // publishGiveaway/endGiveaway) — enough to blow Discord's three-second
  // first-response window. Deferring buys fifteen minutes.
  await defer(bot, interaction, { ephemeral: true });

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

  // Defensive fallback, not dead code. Discord validates subcommand names
  // against the registered `definition` above before routing here, so this
  // is unreachable today — but `definition` and this if-chain are two
  // separate objects kept in sync only by hand. Without this, a fourth
  // subcommand added to `definition` without a matching branch here would
  // defer above and then fall off the end of the function having never
  // finished, leaving the interaction on "thinking..." for the full fifteen
  // minutes. Before this file deferred, the same gap produced Discord's own
  // "This interaction failed" after three seconds — worse UX, but at least
  // truthful. See interactionCreate.ts's catch-all comment: "A hang is worse
  // than an error message — the error at least tells the truth."
  return respond(bot, interaction, "Unrecognised subcommand.");
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
