// bot/src/interactions/buttons/ticketAsk.ts
// A ticket-panel button whose category has questions: show them as a pop-up.
// Submitting the pop-up opens the ticket (handleTicketModalSubmit in
// ticketOpen.ts).
//
// A pop-up must be this interaction's FIRST response, so this handler answers
// with it straight away and never postpones the reply. The one lookup before it
// is a single indexed read.

import { and, eq } from "drizzle-orm";
import type { AppealyBot } from "../../core/client.ts";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { encodeCustomId } from "../../../../shared/types/index.ts";

export async function handleTicketAskButton(
  bot: AppealyBot,
  interaction: Interaction,
  configId: string,
  categoryId: string,
) {
  const category = await db.query.ticketCategories.findFirst({
    where: and(eq(schema.ticketCategories.id, categoryId), eq(schema.ticketCategories.configId, configId)),
  });

  if (!category || category.questions.length === 0) {
    return bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: { flags: 64, content: "That option was removed by the server's staff. Please use the panel's current buttons." },
    });
  }

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 9,
    data: {
      customId: encodeCustomId("ticket", "submit", configId, categoryId),
      title: category.label.slice(0, 45),
      components: category.questions.slice(0, 5).map((q, i) => ({
        type: 1,
        components: [
          {
            type: 4,
            customId: `q${i}`,
            label: q.label.slice(0, 45),
            style: q.paragraph ? 2 : 1,
            required: q.required,
            maxLength: q.paragraph ? 1000 : 200,
          },
        ],
      })),
    },
  });
}
