// bot/src/commands/ticketPanel.ts
// /ticket-panel create — quick-start command mirroring /panel create for
// application forms. Full config (channel type, support roles, transcript
// channel) is set via the dashboard; this creates a config with sane
// defaults and immediately publishes its open-ticket button.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { publishTicketPanel } from "../services/ticketPanelService.ts";

const ADMINISTRATOR = 0x8n;
const EPHEMERAL = 64;

export const definition: CreateApplicationCommand = {
  name: "ticket-panel",
  description: "Manage ticket panels",
  type: ApplicationCommandTypes.ChatInput,
  // Discordeno takes permission NAMES here, not a bitfield string. The
  // old form type-checked against nothing and would have registered the
  // command with a permission value Discord could not parse.
  defaultMemberPermissions: ["ADMINISTRATOR"],
  options: [
    {
      name: "create",
      description: "Create and publish a ticket panel in this channel",
      type: ApplicationCommandOptionTypes.SubCommand,
      options: [
        { name: "name", description: "Ticket type name (e.g. Support)", type: ApplicationCommandOptionTypes.String, required: true },
        {
          name: "channel_type",
          description: "How opened tickets should appear",
          type: ApplicationCommandOptionTypes.String,
          required: false,
          choices: [
            { name: "Private channel", value: "private_channel" },
            { name: "Private thread", value: "private_thread" },
            { name: "Public thread", value: "public_thread" },
          ],
        },
        { name: "support_role", description: "Role that can view/manage tickets", type: ApplicationCommandOptionTypes.Role, required: false },
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
  const name = String(opts.name);
  const channelType = (opts.channel_type as string) ?? "private_channel";
  const supportRoleId = opts.support_role ? String(opts.support_role) : null;

  const [config] = await db
    .insert(schema.ticketConfigs)
    .values({
      guildId,
      name,
      channelId,
      channelType: channelType as "private_channel" | "private_thread" | "public_thread",
      supportRoleIds: supportRoleId ? [supportRoleId] : [],
    })
    .returning();

  await publishTicketPanel(bot, config.id);

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content: `Ticket panel **${name}** published.`, flags: EPHEMERAL },
  });
}
