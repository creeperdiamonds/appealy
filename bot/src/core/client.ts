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
import { resolveSharding } from "./sharding.ts";

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
      GatewayIntents.MessageContent |
      // Needed for guildBanAdd, which drives the ban-appeal DM. NOTE: renamed
      // across versions — GuildModeration in Discordeno v18, GuildBans in
      // older releases. If this fails to compile, check @discordeno/bot's
      // GatewayIntents export before assuming the feature is broken.
      GatewayIntents.GuildModeration,
    desiredProperties,
  });

  registerEventHandlers(bot);

  return bot;
}

export type AppealyBot = ReturnType<typeof createAppealyBot>;

export async function startBot(bot: AppealyBot) {
  // Shard count is resolved from the live guild count before connecting.
  // Discord's own recommendation acts as a floor — see core/sharding.ts for
  // why the count can't change while running.
  const plan = await resolveSharding(env.DISCORD_BOT_TOKEN);

  // ⚠️ v18 API SURFACE: `bot.gateway.totalShards` is the documented field in
  // Discordeno v18, but the gateway manager's shape has moved between minor
  // versions (the note at the top of this file applies here too). Assigning
  // defensively rather than assuming: if the property is missing, log it
  // rather than silently running on one shard while believing otherwise.
  const gw = (bot as unknown as { gateway?: Record<string, unknown> }).gateway;
  if (gw && "totalShards" in gw) {
    gw.totalShards = plan.totalShards;
    if ("lastShardId" in gw) gw.lastShardId = plan.totalShards - 1;
  } else if (plan.totalShards > 1) {
    logger.error(
      "Could not set totalShards on this Discordeno build — the bot will run single-sharded. " +
        "Check @discordeno/bot's gateway manager API for the current field name.",
      { wanted: plan.totalShards },
    );
  }

  logger.info("Starting Appealy gateway connection...", { shards: plan.totalShards });
  await bot.start();
  logger.info("Appealy bot connected.", { shards: plan.totalShards });

  return plan;
}
