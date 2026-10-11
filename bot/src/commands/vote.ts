// bot/src/commands/vote.ts
//
// /vote — vote for Appealy on top.gg, then spend the vote on a small perk for
// this server. The vote itself arrives at the API's top.gg webhook
// (api/src/routes/topggWebhook.ts) and waits there as an unspent vote; this
// command offers the perks, and interactions/selects/votePerk.ts applies the
// one picked. What the perks are and why they're small:
// shared/schema/votePerks.ts.
//
// Spending happens HERE, in the server, rather than automatically when the
// vote lands, because a vote on top.gg doesn't say which server it's for.

import { ApplicationCommandTypes, ButtonStyles, MessageComponentTypes } from "@discordeno/bot";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot, AppealyInteraction as Interaction } from "../core/client.ts";
import { env } from "../core/env.ts";
import { withRedis } from "../core/redis.ts";
import { defer, finish } from "../utils/interactionResponse.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import {
  findPerk,
  parseActivePerk,
  VOTE_PERKS,
  voteKey,
  votePerkKey,
} from "../../../shared/schema/votePerks.ts";

export const definition: CreateApplicationCommand = {
  name: "vote",
  description: "Vote for Appealy on top.gg and pick a small perk for this server",
  descriptionLocalizations: { ja: "top.gg で Appealy に投票して、このサーバーの特典を選びます" },
  type: ApplicationCommandTypes.ChatInput,
  dmPermission: false,
};

export const voteUrl = () => `https://top.gg/bot/${env.DISCORD_APPLICATION_ID}/vote`;

/** "Right now: +50 applications a day, until <t:…:R>." or nothing. */
export function activePerkLine(raw: string | null): string | null {
  const active = parseActivePerk(raw);
  const perk = active && findPerk(active.perk);
  if (!active || !perk) return null;
  return `This server has **${perk.label}** until <t:${Math.floor(active.until / 1000)}:f>.`;
}

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const user = interaction.member?.user ?? interaction.user;
  if (!guildId || !user) return;

  await defer(bot, interaction, { ephemeral: true });

  const [vote, perkRaw] = await withRedis(
    (r) => Promise.all([r.get(voteKey(user.id.toString())), r.get(votePerkKey(guildId.toString()))]),
    [null, null] as (string | null)[],
  );
  const current = activePerkLine(perkRaw);

  if (!vote) {
    return finish(bot, interaction, {
      embeds: [
        {
          title: "Vote for Appealy",
          description: [
            "Voting on top.gg helps other servers find Appealy. Every vote gets this server a small perk for 24 hours.",
            "",
            "1. Vote with the button below.",
            "2. Come back and run `/vote` here again to pick your perk.",
            "",
            "You can vote every 12 hours. One perk at a time per server; a new one replaces the old one.",
            current ? `\n${current}` : null,
          ].filter((l) => l !== null).join("\n"),
          color: 0x5865f2,
        },
      ],
      components: [
        {
          type: MessageComponentTypes.ActionRow,
          components: [
            { type: MessageComponentTypes.Button, style: ButtonStyles.Link, label: "Vote on top.gg", url: voteUrl() },
          ],
        },
      ],
    });
  }

  return finish(bot, interaction, {
    embeds: [
      {
        title: "Thanks for voting!",
        description: [
          "Pick a perk for this server. It lasts 24 hours.",
          current ? `\n${current} Picking one now replaces it.` : null,
        ].filter((l) => l !== null).join("\n"),
        color: 0x57f287,
      },
    ],
    components: [
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.SelectMenu,
            // entityId is the voter: only they can spend their vote.
            customId: encodeCustomId("vote", "perk", user.id.toString()),
            placeholder: "Choose a perk",
            options: VOTE_PERKS.map((p) => ({ label: p.label, value: p.id, description: "For 24 hours" })),
          },
        ],
      },
    ],
  });
}
