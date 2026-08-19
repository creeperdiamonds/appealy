// bot/src/core/client.ts
//
// Discordeno v20 client construction.
//
// NOTE ON API STABILITY: Discordeno's low-level gateway manager APIs
// (createGatewayManager, handleDiscordPayload wiring) have changed shape
// across releases. Rather than hand-roll that wiring and risk
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
    // Read by the welcomer and the leave handler for the "you're member #N"
    // line. Undeclared, it is absent at runtime, not just untyped.
    memberCount: true,
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
    // Every staff gate reads this: reviewing, denying, closing a ticket,
    // resetting a cooldown. Undeclared, the checks would see undefined and
    // fail closed for everyone.
    permissions: true,
    // Needed to know which guild a join belongs to; guildMemberAdd hands the
    // member and the user separately and only the member carries it.
    guildId: true,
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
    // Ticket transcripts include what was attached, not just what was typed.
    attachments: true,
    // Review and denial flows edit the original review message in place, which
    // means reading the embed they are about to rewrite.
    embeds: true,
  },
  channel: {
    id: true,
    guildId: true,
    name: true,
    type: true,
    permissionOverwrites: true,
    // Used when creating a ticket channel under the right category.
    position: true,
  },
  // /import-appy takes a file upload, so it needs the parts of an attachment
  // that identify and fetch it.
  attachment: {
    id: true,
    filename: true,
    size: true,
    url: true,
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

/**
 * Builds a bot client.
 *
 * Takes the token rather than reading it from the environment so a single
 * process can run more than one client. That is what dedicated hosting needs:
 * a customer's own bot is this same code on their own token, and giving each
 * one its own always-on container costs far more per year than the hosting is
 * sold for. Several clients sharing one process amortises that.
 *
 * Defaults to the platform token, so every existing caller is unaffected.
 */
export function createAppealyBot(token: string = env.DISCORD_BOT_TOKEN) {
  const bot = createBot({
    token,
    // botId is no longer an option — the library derives it from the token,
    // which is the same value and one fewer thing to get wrong.
    intents:
      GatewayIntents.Guilds |
      GatewayIntents.GuildMembers |
      GatewayIntents.GuildMessages |
      GatewayIntents.MessageContent |
      // Needed for guildBanAdd, which drives the ban-appeal DM. Renamed across
      // releases: GuildModeration here, GuildBans in older ones. If this stops
      // compiling, check the GatewayIntents export before assuming the feature
      // is broken.
      GatewayIntents.GuildModeration,
    desiredProperties,
  });

  registerEventHandlers(bot);

  return bot;
}

export type AppealyBot = ReturnType<typeof createAppealyBot>;

// The library types every payload against `desiredProperties` above, so the
// raw `Interaction`/`Guild`/`Member` types from @discordeno/bot are wider than
// what a handler is actually handed and are not assignable to it. Deriving the
// types from the bot instance keeps them correct by construction: change
// desiredProperties and these follow, instead of drifting until something
// reads a field that was never requested.
type EventArgs<K extends keyof AppealyBot["events"]> =
  Parameters<NonNullable<AppealyBot["events"][K]>>;

export type AppealyInteraction = EventArgs<"interactionCreate">[0];
export type AppealyGuild = EventArgs<"guildCreate">[0];
export type AppealyMember = EventArgs<"guildMemberAdd">[0];
export type AppealyUser = EventArgs<"guildBanAdd">[0];
export type AppealyMessage = EventArgs<"messageCreate">[0];

export async function startBot(bot: AppealyBot, token: string = env.DISCORD_BOT_TOKEN) {
  // Shard count is resolved from the live guild count before connecting.
  // Discord's own recommendation acts as a floor — see core/sharding.ts for
  // why the count can't change while running.
  //
  // Must be the SAME token the client was built with. A dedicated customer's
  // bot is in one guild and needs one shard; resolving against the platform
  // token instead would size it against the platform's guild count.
  const plan = await resolveSharding(token);

  // ⚠️ GATEWAY SHAPE: `bot.gateway.totalShards` is the documented field, but
  // the gateway manager's shape has moved between minor
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
