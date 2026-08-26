// bot/src/commands/roleMenu.ts
// /role-menu create — quick-start to publish a self-assignable role menu
// with up to 5 roles via command options. For more than 5 options, use
// the dashboard's role menu builder (api/src/routes/roleMenus.ts).

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { publishRoleMenu } from "../services/roleMenuService.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

const ADMINISTRATOR = 0x8n;

export const definition: CreateApplicationCommand = {
  name: "role-menu",
  description: "Manage self-assignable role menus",
  type: ApplicationCommandTypes.ChatInput,
  // Discordeno takes permission NAMES here, not a bitfield string. The
  // old form type-checked against nothing and would have registered the
  // command with a permission value Discord could not parse.
  defaultMemberPermissions: ["ADMINISTRATOR"],
  options: [
    {
      name: "create",
      description: "Create and publish a role menu in this channel",
      type: ApplicationCommandOptionTypes.SubCommand,
      options: [
        { name: "title", description: "Menu title", type: ApplicationCommandOptionTypes.String, required: true },
        { name: "mode", description: "Selection mode", type: ApplicationCommandOptionTypes.String, required: true, choices: [
          { name: "Multiple roles allowed", value: "multi" },
          { name: "Only one role at a time", value: "single" },
        ] },
        { name: "role1", description: "Role option 1", type: ApplicationCommandOptionTypes.Role, required: true },
        { name: "label1", description: "Label for role option 1", type: ApplicationCommandOptionTypes.String, required: true },
        { name: "role2", description: "Role option 2", type: ApplicationCommandOptionTypes.Role, required: false },
        { name: "label2", description: "Label for role option 2", type: ApplicationCommandOptionTypes.String, required: false },
        { name: "role3", description: "Role option 3", type: ApplicationCommandOptionTypes.Role, required: false },
        { name: "label3", description: "Label for role option 3", type: ApplicationCommandOptionTypes.String, required: false },
        { name: "role4", description: "Role option 4", type: ApplicationCommandOptionTypes.Role, required: false },
        { name: "label4", description: "Label for role option 4", type: ApplicationCommandOptionTypes.String, required: false },
        { name: "role5", description: "Role option 5", type: ApplicationCommandOptionTypes.Role, required: false },
        { name: "label5", description: "Label for role option 5", type: ApplicationCommandOptionTypes.String, required: false },
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

  // The menu/option inserts and publishRoleMenu() below (which posts the
  // message and stores its id) are several DB round trips plus a REST
  // call — enough to blow Discord's three-second first-response window.
  // Deferring buys fifteen minutes.
  await defer(bot, interaction, { ephemeral: true });

  const [menu] = await db
    .insert(schema.roleMenus)
    .values({
      guildId,
      channelId,
      title: String(opts.title),
      selectionMode: String(opts.mode) as "single" | "multi",
    })
    .returning();

  const optionRows = [];
  for (let i = 1; i <= 5; i++) {
    const roleId = opts[`role${i}`];
    const label = opts[`label${i}`];
    if (roleId && label) {
      optionRows.push({ menuId: menu.id, roleId: BigInt(String(roleId)), label: String(label), sortOrder: i });
    }
  }

  if (optionRows.length === 0) {
    await db.delete(schema.roleMenus).where(eq(schema.roleMenus.id, menu.id));
    return respond(bot, interaction, "At least one role/label pair is required.");
  }

  await db.insert(schema.roleMenuOptions).values(optionRows);
  await publishRoleMenu(bot, menu.id);

  await respond(bot, interaction, `Role menu **${menu.title}** published with ${optionRows.length} option(s).`);
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
