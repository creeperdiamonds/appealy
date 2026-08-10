// bot/src/core/client.ts
//
// Discordeno v18 client construction.
//
// NOTE ON API STABILITY: Discordeno's low-level gateway manager APIs
// (createGatewayManager, handleDiscordPayload wiring) have changed shape
// across v17/v18 releases. Rather than hand-roll that wiring and risk
// silently drifting from whatever patch version you install, this file
// uses the high-level `bot.start()` helper that createBot() attaches,
// which Discordeno maintains as the stable entrypoint for single-process
// bots. If you need custom sharding/gateway control (multi-process,
// external gateway proxy), swap this for @discordeno/gateway's
// createShardManager directly -- see README.md "Scaling beyond one process".

import { createBot, GatewayIntents } from "@discordeno/bot";
import { env } from "./env.ts";
import { logger } from "../utils/logger.ts";
import { registerEventHandlers } from "../events/index.ts";

export const desiredProperties = {
  guild: {
    id: true,
    name: true,
    ownerId: true,
    roles: true,
    icon: true,
  },
  role: {
    id: true,
    name: true,
    position: true,
    permissions: true,
    color: true,
  },
  member: {
    id: true,
    roles: true,
    user: true,
    nick: true,
    communicationDisabledUntil: true,
  },
  user: {
    id: true,
    username: true,
    discriminator: true,
    avatar: true,
    toggles: true,
  },
  message: {
    id: true,
    channelId: true,
    guildId: true,
    author: true,
    content: true,
  },
  channel: {
    id: true,
    guildId: true,
    name: true,
    type: true,
    permissionOverwrites: true,
  },
  interaction: {
    id: true,
    applicationId: true,
    type: true,
    data: true,
    guildId: true,
    channelId: true,
    member: true,
    user: true,
    token: true,
    message: true,
    locale: true,
  },
} as const;

export function createAppealyBot() {
  const bot = createBot({
    token: env.DISCORD_BOT_TOKEN,
    botId: BigInt(env.DISCORD_APPLICATION_ID),
    intents:
      GatewayIntents.Guilds |
      GatewayIntents.GuildMembers |
      GatewayIntents.GuildMessages |
      GatewayIntents.MessageContent,
    desiredProperties,
  });

  registerEventHandlers(bot);

  return bot;
}

export type AppealyBot = ReturnType<typeof createAppealyBot>;

export async function startBot(bot: AppealyBot) {
  logger.info("Starting Appealy gateway connection...");
  await bot.start();
  logger.info("Appealy bot connected.");
}
