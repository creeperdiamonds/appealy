// bot/src/events/index.ts
// Central registry that attaches all gateway event handlers to the bot
// instance. Each handler lives in its own file to keep this file a pure
// wiring manifest.

import type { AppealyBot } from "../core/client.ts";
import { onReady } from "./ready.ts";
import { onGuildCreate } from "./guildCreate.ts";
import { onInteractionCreate } from "./interactionCreate.ts";
import { onGuildMemberRemove } from "./guildMemberRemove.ts";
import { onGuildMemberAdd } from "./guildMemberAdd.ts";
import { onMessageCreate } from "./messageCreate.ts";

export function registerEventHandlers(bot: AppealyBot) {
  bot.events.ready = onReady;
  bot.events.guildCreate = (guild, shardId) => onGuildCreate(guild, shardId ?? 0);
  bot.events.interactionCreate = onInteractionCreate(bot);
  bot.events.guildMemberRemove = onGuildMemberRemove(bot);
  bot.events.guildMemberAdd = onGuildMemberAdd(bot);
  bot.events.messageCreate = onMessageCreate(bot);
}
