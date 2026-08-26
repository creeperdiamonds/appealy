// bot/src/commands/formList.ts
// /forms — lists all forms configured for the guild with quick status info.

import { ApplicationCommandTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { defer, finish } from "../utils/interactionResponse.ts";

export const definition: CreateApplicationCommand = {
  name: "forms",
  description: "List all application forms configured in this server",
  type: ApplicationCommandTypes.ChatInput,
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  // Deferring here is cheap insurance rather than a fix for an observed
  // failure — a single indexed select is normally well under the
  // three-second window — but every other command in this file's family
  // now follows the same defer/work/finish shape, and a fast query today
  // is not a guarantee against a slow one after the table grows.
  await defer(bot, interaction, { ephemeral: true });

  const forms = await db.select().from(schema.forms).where(eq(schema.forms.guildId, guildId));

  if (forms.length === 0) {
    return respond(bot, interaction, "No forms configured yet. Use the dashboard to create one.");
  }

  const lines = forms.map(
    (f) => `${f.active ? "🟢" : "⚪"} **${f.name}** — <#${f.logChannelId}> (${f.id})`,
  );

  await finish(bot, interaction, {
    embeds: [
      {
        title: "Configured Forms",
        description: lines.join("\n"),
        color: 0x5865f2,
      },
    ],
  });
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
