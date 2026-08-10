// bot/src/commands/panelCreate.ts
// /panel create — quick-start command to create and publish a panel with
// one form attached. Full multi-form panel layout is managed via the
// dashboard; this command exists for fast single-form setups.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { Interaction, CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { eq } from "drizzle-orm";

const ADMINISTRATOR = 0x8n;
const EPHEMERAL = 64;

export const definition: CreateApplicationCommand = {
  name: "panel",
  description: "Manage application panels",
  type: ApplicationCommandTypes.ChatInput,
  defaultMemberPermissions: ADMINISTRATOR.toString(),
  options: [
    {
      name: "create",
      description: "Create and publish a panel for a form in this channel",
      type: ApplicationCommandOptionTypes.SubCommand,
      options: [
        {
          name: "form",
          description: "The form to attach",
          type: ApplicationCommandOptionTypes.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "title",
          description: "Panel title",
          type: ApplicationCommandOptionTypes.String,
          required: true,
        },
        {
          name: "description",
          description: "Panel description",
          type: ApplicationCommandOptionTypes.String,
          required: false,
        },
      ],
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  if (!guildId || !channelId) return;

  const sub = interaction.data?.options?.[0];
  if (sub?.name !== "create") return;

  const opts = Object.fromEntries((sub.options ?? []).map((o) => [o.name, o.value]));
  const formId = String(opts.form);
  const title = String(opts.title);
  const description = opts.description ? String(opts.description) : "";

  const form = await db.query.forms.findFirst({ where: eq(schema.forms.id, formId) });
  if (!form || form.guildId !== guildId) {
    return respond(bot, interaction, "That form doesn't exist in this server.");
  }

  const [panel] = await db
    .insert(schema.panels)
    .values({ guildId, channelId, title, description, published: false })
    .returning();

  await db.insert(schema.panelButtons).values({
    panelId: panel.id,
    formId: form.id,
    label: "Apply",
    style: "primary",
    sortOrder: 0,
  });

  const message = await bot.helpers.sendMessage(channelId, {
    embeds: [{ title, description, color: panel.color ?? 0x5865f2 }],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "Apply",
            customId: encodeCustomId("panel", "open", form.id),
          },
        ],
      },
    ],
  });

  await db
    .update(schema.panels)
    .set({ messageId: message.id, published: true })
    .where(eq(schema.panels.id, panel.id));

  await respond(bot, interaction, `Panel published for **${form.name}**.`);
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
