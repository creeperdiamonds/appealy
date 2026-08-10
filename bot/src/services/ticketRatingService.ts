// bot/src/services/ticketRatingService.ts
//
// Sends the ticket opener a DM with 1-5 star buttons right after their
// ticket closes, if the config has ratingEnabled. Matches the reference
// dashboard's "Rate Support Experience" feature and its per-agent
// aggregated rating display.

import { eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { logger } from "../utils/logger.ts";

export async function sendRatingPrompt(bot: AppealyBot, ticketId: string, openerId: bigint) {
  try {
    const dmChannel = await bot.helpers.getDmChannel(openerId);
    await bot.helpers.sendMessage(dmChannel.id, {
      content: "How was your support experience? Tap a rating below.",
      components: [
        {
          type: 1,
          components: [1, 2, 3, 4, 5].map((n) => ({
            type: 2,
            style: 2,
            label: "⭐".repeat(n),
            customId: encodeCustomId("ticket", "rate", ticketId, String(n)),
          })),
        },
      ],
    });
  } catch (err) {
    // DMs closed — non-fatal, rating just stays null forever for this ticket
    logger.warn("Failed to send ticket rating prompt", { ticketId, error: String(err) });
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
