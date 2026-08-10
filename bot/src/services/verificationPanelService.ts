// bot/src/services/verificationPanelService.ts
// Publishes the verification panel message, shared by /verify-setup and
// the dashboard's "publish" button (via the internal control server).

import { eq } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";

export async function publishVerificationPanel(bot: AppealyBot, guildId: bigint) {
  const config = await db.query.verificationConfigs.findFirst({ where: eq(schema.verificationConfigs.guildId, guildId) });
  if (!config || !config.channelId) throw new Error("verification_not_configured");

  const message = await bot.helpers.sendMessage(config.channelId, {
    embeds: [{ title: config.panelTitle, description: config.panelDescription ?? "", color: 0x5865f2 }],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "Verify", customId: encodeCustomId("verify", "start", guildId.toString()) },
        ],
      },
    ],
  });

  await db.update(schema.verificationConfigs).set({ messageId: message.id }).where(eq(schema.verificationConfigs.guildId, guildId));
  return message;
}
