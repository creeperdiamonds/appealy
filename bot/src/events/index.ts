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

/**
 * Which shard a guild belongs to, by Discord's own formula.
 *
 * guildCreate no longer carries a shard id, and the startup profiler needs one
 * to know when a shard has finished streaming its guilds. This is the same
 * arithmetic the gateway itself uses to route the guild, so it agrees with
 * whichever shard actually delivered the event.
 */
function shardIdForGuild(bot: AppealyBot, guildId: bigint): number {
  const total = bot.gateway?.totalShards ?? 1;
  return Number((guildId >> 22n) % BigInt(total || 1));
}

export function registerEventHandlers(bot: AppealyBot) {
  // Handlers are built once here rather than per event: several of them close
  // over state, and rebuilding on every dispatch would throw it away.
  const banAdd = onGuildBanAdd(bot);
  const memberRemove = onGuildMemberRemove(bot);
  const memberAdd = onGuildMemberAdd(bot);

  bot.events.ready = (payload) => onReady(bot, payload);
  // (user, guildId) now, not one payload object.
  bot.events.guildBanAdd = (user, guildId) => banAdd({ guildId, user });

  // ⚠️ Renewals emit NO event. ENTITLEMENT_UPDATE fires only when a
  // subscription ends, carrying ends_at. Silence means healthy, not expired —
  // see core/entitlements.ts.
  bot.events.entitlementCreate = (e) => onEntitlementEvent("create", e as never);
  bot.events.entitlementUpdate = (e) => onEntitlementEvent("update", e as never);
  bot.events.entitlementDelete = (e) => onEntitlementEvent("delete", e as never);
  bot.events.guildCreate = (guild) => onGuildCreate(guild, shardIdForGuild(bot, guild.id));
  bot.events.interactionCreate = onInteractionCreate(bot);
  bot.events.guildMemberRemove = (user, guildId) => memberRemove({ guildId, user });
  // (member, user) now. The handler wants them together, and only the member
  // carries guildId.
  bot.events.guildMemberAdd = (member, user) =>
    memberAdd({ guildId: member.guildId, user });
  bot.events.messageCreate = onMessageCreate(bot);
}
