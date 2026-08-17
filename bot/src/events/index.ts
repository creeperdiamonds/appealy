// bot/src/events/index.ts
// Central registry that attaches all gateway event handlers to the bot
// instance. Each handler lives in its own file to keep this file a pure
// wiring manifest.

import type { AppealyBot } from "../core/client.ts";
import { onReady } from "./ready.ts";
import { onGuildBanAdd } from "./guildBanAdd.ts";
import { onEntitlementEvent } from "../core/entitlements.ts";
import { onGuildCreate } from "./guildCreate.ts";
import { onInteractionCreate } from "./interactionCreate.ts";
import { onGuildMemberRemove } from "./guildMemberRemove.ts";
import { onGuildMemberAdd } from "./guildMemberAdd.ts";
import { onMessageCreate } from "./messageCreate.ts";

export function registerEventHandlers(bot: AppealyBot) {
  bot.events.ready = (payload) => onReady(bot, payload);
  bot.events.guildBanAdd = onGuildBanAdd(bot);

  // ⚠️ Renewals emit NO event. ENTITLEMENT_UPDATE fires only when a
  // subscription ends, carrying ends_at. Silence means healthy, not expired —
  // see core/entitlements.ts.
  bot.events.entitlementCreate = (e) => onEntitlementEvent("create", e as never);
  bot.events.entitlementUpdate = (e) => onEntitlementEvent("update", e as never);
  bot.events.entitlementDelete = (e) => onEntitlementEvent("delete", e as never);
  bot.events.guildCreate = (guild, shardId) => onGuildCreate(guild, shardId ?? 0);
  bot.events.interactionCreate = onInteractionCreate(bot);
  bot.events.guildMemberRemove = onGuildMemberRemove(bot);
  bot.events.guildMemberAdd = onGuildMemberAdd(bot);
  bot.events.messageCreate = onMessageCreate(bot);
}
