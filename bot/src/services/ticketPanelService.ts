// bot/src/services/ticketPanelService.ts
// Publishes/re-syncs the "Open Ticket" panel message for a ticket config,
// mirroring the pattern used for application panels in core/controlServer.ts.
//
// A config with no categories gets its single button. A config with
// categories gets one button per category (Discord allows 5 per row, 5 rows),
// and the member picks which kind of ticket they want.
//
// Custom IDs: ticket:open:<configId>[:<categoryId>] opens the ticket straight
// away; ticket:ask:<configId>:<categoryId> first shows the category's
// questions as a pop-up. Which one a button carries is decided here, at
// publish time, so the click handler can answer a pop-up as its FIRST response
// without looking anything up (a modal can't follow a deferral).

import { eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { emojiForComponent } from "../../../shared/lib/emoji.ts";

export async function publishTicketPanel(bot: AppealyBot, configId: string) {
  const config = await db.query.ticketConfigs.findFirst({
    where: eq(schema.ticketConfigs.id, configId),
    with: { categories: { orderBy: (c, { asc }) => [asc(c.sortOrder), asc(c.createdAt)] } },
  });
  if (!config) throw new Error("ticket_config_not_found");

  const categories = config.categories.slice(0, 25);

  const buttons =
    categories.length === 0
      ? [
          {
            type: 2,
            style: 1,
            label: config.buttonLabel,
            emoji: emojiForComponent(config.buttonEmoji),
            customId: encodeCustomId("ticket", "open", config.id),
          },
        ]
      : categories.map((c) => ({
          type: 2,
          style: 1,
          label: c.label,
          emoji: emojiForComponent(c.emoji),
          customId: encodeCustomId("ticket", c.questions.length > 0 ? "ask" : "open", config.id, c.id),
        }));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }

  // What each button is for, where the member can read it before clicking.
  const described = categories.filter((c) => c.description);

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
        fields: described.map((c) => ({
          name: `${c.emoji ? `${c.emoji} ` : ""}${c.label}`.slice(0, 256),
          value: c.description!,
        })),
      },
    ],
    // Built in a loop, so the literal types Discord's component union wants
    // are widened to number; the shapes are the same as the one-button case.
    components: rows as never,
  });

  return message;
}
