// bot/src/services/roleMenuService.ts
// Publishes/re-syncs a self-assignable role menu's message.

import { eq } from "drizzle-orm";
import type { MessageComponent } from "@discordeno/bot";
import { MessageComponentTypes, ButtonStyles } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";

export async function publishRoleMenu(bot: AppealyBot, menuId: string) {
  const menu = await db.query.roleMenus.findFirst({
    where: eq(schema.roleMenus.id, menuId),
    with: { options: { orderBy: (o, { asc }) => [asc(o.sortOrder)] } },
  });
  if (!menu) throw new Error("role_menu_not_found");
  if (menu.options.length === 0) throw new Error("role_menu_has_no_options");

  // Annotated so the nested arrays are checked against the action-row tuple
  // types rather than inferred as plain arrays, which nothing accepts.
  const components: MessageComponent[] = [
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.SelectMenu,
            customId: encodeCustomId("rolemenu", "select", menu.id),
            placeholder: "Choose your roles",
            minValues: 0,
            maxValues: menu.selectionMode === "single" ? 1 : menu.options.length,
            options: menu.options.slice(0, 25).map((o) => ({
              label: o.label,
              value: o.roleId.toString(),
              description: o.description ?? undefined,
              emoji: o.emoji ? { name: o.emoji } : undefined,
            })),
          },
        ],
      },
  ];

  const payload = {
    embeds: [{ title: menu.title, description: menu.description ?? "", color: 0x5865f2 }],
    components,
  };

  if (menu.messageId) {
    await bot.helpers.editMessage(menu.channelId, menu.messageId, payload);
    return;
  }

  const message = await bot.helpers.sendMessage(menu.channelId, payload);
  await db.update(schema.roleMenus).set({ messageId: message.id, published: true }).where(eq(schema.roleMenus.id, menuId));
}
