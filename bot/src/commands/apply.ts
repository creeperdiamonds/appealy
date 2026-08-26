// bot/src/commands/apply.ts
//
// /apply <application_name> — the primary way members start an application,
// independent of whether a panel has been published. Shares all gating and
// modal-building logic with the panel-button flow (bot/src/interactions/buttons/panelOpen.ts)
// via runApplicationFlow, so behavior never drifts between the two entry points.

import {
  ApplicationCommandTypes,
  ApplicationCommandOptionTypes,
} from "@discordeno/bot";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq, and, like } from "drizzle-orm";
import { runApplicationFlow } from "../interactions/buttons/panelOpen.ts";

const EPHEMERAL = 64;

export const definition: CreateApplicationCommand = {
  name: "apply",
  description: "Apply for an application form in this server",
  type: ApplicationCommandTypes.ChatInput,
  options: [
    {
      name: "application_name",
      description: "The name of the application to apply for",
      type: ApplicationCommandOptionTypes.String,
      required: true,
      autocomplete: true,
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return respond(bot, interaction, "This command can only be used in a server.");
  }

  const formName = String(interaction.data?.options?.[0]?.value ?? "");
  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.guildId, guildId), eq(schema.forms.name, formName), eq(schema.forms.active, true)),
  });

  if (!form) {
    return respond(
      bot,
      interaction,
      `No active application found named **${formName}**. Use \`/apply\` and start typing to see available applications.`,
    );
  }

  await runApplicationFlow(bot, interaction, form.id);
}

/** Autocomplete handler — Discord sends a separate interaction type
 * (ApplicationCommandAutocomplete) while the user is typing the option
 * value; routed here from events/interactionCreate.ts. */
export async function autocomplete(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const typed = String(interaction.data?.options?.[0]?.value ?? "");
  if (!guildId) return;

  const matches = await db
    .select({ name: schema.forms.name })
    .from(schema.forms)
    .where(and(eq(schema.forms.guildId, guildId), eq(schema.forms.active, true), like(schema.forms.name, `%${typed}%`)))
    .limit(25);

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 8, // APPLICATION_COMMAND_AUTOCOMPLETE_RESULT
    data: {
      choices: matches.map((m) => ({ name: m.name, value: m.name })),
    },
  });
}

/** Sends the FIRST response (type 4), unlike the identically-named respond()
 * in the 22 defer/finish handlers, which edits an already-deferred one. That
 * is deliberate and must stay: /apply's happy path ends in a modal via
 * runApplicationFlow, and a deferred interaction can never open one — see
 * deferGuard.test.ts's dedicated apply.ts block. Do not "normalise" this to
 * finish(). */
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
