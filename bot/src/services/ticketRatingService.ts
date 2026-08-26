// bot/src/services/ticketRatingService.ts
//
// Sends the ticket opener a DM with 1-5 star buttons right after their
// ticket closes, if the config has ratingEnabled. Matches the reference
// dashboard's "Rate Support Experience" feature and its per-agent
// aggregated rating display.

import { eq } from "drizzle-orm";
import type { ButtonComponent } from "@discordeno/bot";
import { MessageComponentTypes, ButtonStyles } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { logger } from "../utils/logger.ts";
import { describeDiscordError } from "../utils/discordError.ts";

/** One rating button. Split out so the row below stays readable. */
function star(ticketId: string, n: number): ButtonComponent {
  return {
    type: MessageComponentTypes.Button,
    style: ButtonStyles.Secondary,
    label: "⭐".repeat(n),
    customId: encodeCustomId("ticket", "rate", ticketId, String(n)),
  };
}

export async function sendRatingPrompt(bot: AppealyBot, ticketId: string, openerId: bigint) {
  try {
    const dmChannel = await bot.helpers.getDmChannel(openerId);
    await bot.helpers.sendMessage(dmChannel.id, {
      content: "How was your support experience? Tap a rating below.",
      components: [
        {
          type: MessageComponentTypes.ActionRow,
          // Written out rather than mapped: an action row's components are
          // typed as fixed-length tuples (one through five), and a mapped
          // array can never satisfy one. There are exactly five ratings.
          components: [1, 2, 3, 4, 5].map((n) => star(ticketId, n)) as [
            ButtonComponent,
            ButtonComponent,
            ButtonComponent,
            ButtonComponent,
            ButtonComponent,
          ],
        },
      ],
    });
  } catch (err) {
    // Was a blanket "DMs are closed" assumption. The 2026-08-23 logs show it
    // also swallowed genuine API failures, which is how three broken tickets
    // looked identical to three users with strict privacy settings. Only
    // Discord code 50007 ("Cannot send messages to this user") actually
    // means DMs are closed; everything else is a real failure worth naming.
    const info = describeDiscordError(err);
    const dmsClosed = info.code === 50007;
    logger.warn(
      dmsClosed
        ? "Ticket rating prompt not sent: recipient has DMs closed"
        : "Failed to send ticket rating prompt",
      { ticketId, status: info.status, code: info.code, detail: info.message },
    );
  }
}

export async function recordRating(ticketId: string, rating: number): Promise<boolean> {
  const result = await db
    .update(schema.tickets)
    .set({ rating })
    .where(eq(schema.tickets.id, ticketId))
    .returning();
  return result.length > 0;
}
