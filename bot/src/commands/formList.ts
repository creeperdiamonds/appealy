// bot/src/commands/formList.ts
// /forms — lists all forms configured for the guild with quick status info.

import { ApplicationCommandTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq } from "drizzle-orm";

const EPHEMERAL = 64;

export const definition: CreateApplicationCommand = {
  name: "forms",
  description: "List all application forms configured in this server",
  type: ApplicationCommandTypes.ChatInput,
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const forms = await db.select().from(schema.forms).where(eq(schema.forms.guildId, guildId));

  if (forms.length === 0) {
    return respond(bot, interaction, "No forms configured yet. Use the dashboard to create one.");
  }

  const lines = forms.map(
    (f) => `${f.active ? "🟢" : "⚪"} **${f.name}** — <#${f.logChannelId}> (${f.id})`,
  );

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: {
      flags: EPHEMERAL,
      embeds: [
        {
          title: "Configured Forms",
          description: lines.join("\n"),
          color: 0x5865f2,
        },
      ],
    },
  });
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
