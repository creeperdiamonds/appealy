// bot/src/services/welcome.ts
//
// Posts the welcome message (services/welcomeMessage.ts) when Appealy is added
// to a server. events/index.ts calls it only for a fresh join, never for the
// guildCreate every server sends again on reconnect.
//
// Best effort: a server with nowhere the bot may post simply gets no message,
// and a failure is logged rather than retried. Joining must never depend on it.

import type { AppealyBot } from "../core/client.ts";
import { deployment, env } from "../core/env.ts";
import { commandIds, PLATFORM_SUPPORT_URL } from "../commands/help.ts";
import { logger } from "../utils/logger.ts";
import { loadSetupGuild } from "./setupCheck.ts";
import { welcomeChannel, welcomeMessage } from "./welcomeMessage.ts";

export async function sendWelcome(bot: AppealyBot, guildId: bigint): Promise<void> {
  // A customer's dedicated bot joins a server the hosted bot already
  // welcomed; one welcome is enough.
  if (bot.id.toString() !== env.DISCORD_APPLICATION_ID) return;
  try {
    const { g, guild, channels } = await loadSetupGuild(bot, guildId);
    const channelId = welcomeChannel(
      g,
      channels.map((c, i) => ({
        id: String(c.id),
        type: Number(c.type),
        position: c.position ?? i,
        overwrites: g.channels[i].overwrites,
      })),
      guild.systemChannelId ? String(guild.systemChannelId) : null,
    );
    if (!channelId) {
      logger.info("Added to a server with nowhere to post the welcome", { guildId: guildId.toString() });
      return;
    }

    const message = welcomeMessage({
      ja: guild.preferredLocale?.startsWith("ja") ?? false,
      brand: deployment.brandName,
      dashboardUrl: `${env.DASHBOARD_URL}/guilds/${guildId}`,
      supportUrl: deployment.supportUrl || (deployment.mode === "platform" ? PLATFORM_SUPPORT_URL : ""),
      ids: await commandIds(bot),
      updatesStep: deployment.mode === "platform",
    });
    // Plain objects, as /help builds them. Discordeno types a row's buttons as
    // fixed-length tuples, which a list of one or two doesn't satisfy.
    await bot.helpers.sendMessage(BigInt(channelId), message as never);
    logger.info("Welcome message sent", { guildId: guildId.toString(), channelId });
  } catch (err) {
    logger.warn("Couldn't send the welcome message", { guildId: guildId.toString(), error: String(err) });
  }
}
