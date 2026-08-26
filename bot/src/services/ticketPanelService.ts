// bot/src/services/ticketPanelService.ts
// Publishes/re-syncs the "Open Ticket" panel message for a ticket config,
// mirroring the pattern used for application panels in core/controlServer.ts.

import { eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";

export async function publishTicketPanel(bot: AppealyBot, configId: string) {
  const config = await db.query.ticketConfigs.findFirst({ where: eq(schema.ticketConfigs.id, configId) });
  if (!config) throw new Error("ticket_config_not_found");

  const message = await bot.helpers.sendMessage(config.channelId, {
    embeds: [
      {
        title: config.name,
        // panelMessage, not welcomeMessage. This embed is public — everyone
        // who can see the channel reads it, before they have a ticket. It
        // used to read welcomeMessage, whose default thanks the reader for
        // opening a ticket they have not opened yet.
        description: config.panelMessage ?? "Click below to open a ticket.",
        color: 0x5865f2,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: config.buttonLabel,
            emoji: config.buttonEmoji ? { name: config.buttonEmoji } : undefined,
            customId: encodeCustomId("ticket", "open", config.id),
          },
        ],
      },
    ],
  });

  return message;
}
