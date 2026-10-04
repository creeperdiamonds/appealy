// bot/src/services/moderation.ts
//
// Runs the text moderation commands parsed in services/modCommands.ts:
// ?ban, ?unban, ?kick, ?mute, ?unmute (and "@Appealy ban …"). Each server
// can change the prefix, limit the commands to roles or turn them off, on the
// dashboard's Moderation page (moderation_configs).
//
// Appeals come for free: a ban or a timeout made here fires the same gateway
// events as one made in Discord's own menu, so events/guildBanAdd.ts and the
// timeout trigger send the appeal button exactly as they always have.
//
// Only reached for messages that already look like a command, so the extra
// requests here (the moderator, the target, the guild) are per command, never
// per message.

import type { AppealyBot } from "../core/client.ts";
import { getGuild } from "../core/guildLookup.ts";
import { getGuildConfig } from "../core/guildConfigCache.ts";
import { clearAppealSuppression, suppressNextAppeal } from "./appealSuppression.ts";
import { cancelUnban, scheduleUnban } from "./tempBans.ts";
import { describeDiscordError } from "../utils/discordError.ts";
import { logger } from "../utils/logger.ts";
import {
  checkAction,
  DEFAULT_PREFIX,
  formatDuration,
  type GuildInfo,
  MAX_TEMPBAN_MS,
  MAX_TIMEOUT_MS,
  type ModAction,
  parseArgs,
  parseModCommand,
  parseUserId,
  refusalText,
  usage,
} from "./modCommands.ts";

/** Without a duration, ?mute lasts an hour, which it says in its reply. */
const DEFAULT_MUTE_MS = 3_600_000;

export interface CommandMessage {
  id: bigint;
  channelId: bigint;
  guildId: bigint;
  authorId: bigint;
  content: string;
}

/** True when the message was a moderation command (handled, or refused). */
/**
 * Whether a message could be a command in this server, without any I/O when
 * the server's settings are cached: the cheap test messageCreate runs before
 * calling handleModerationCommand. Most chat starts with a letter and never
 * gets further than the first character.
 */
export function mightBeCommand(content: string): boolean {
  const c = content.charCodeAt(0);
  // Letters and digits can't start a prefix (they'd be ordinary words) or a mention.
  return content.length > 1 && !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122));
}

export async function handleModerationCommand(bot: AppealyBot, message: CommandMessage): Promise<boolean> {
  const settings = (await getGuildConfig(message.guildId)).moderation;
  // Turned off on the dashboard: both the prefix and "@Appealy ban".
  if (settings && !settings.textCommandsEnabled) return false;
  const prefix = settings?.prefix || DEFAULT_PREFIX;
  const command = parseModCommand(message.content, bot.id, prefix);
  if (!command) return false;
  const { action, args } = command;
  const parsed = parseArgs(action, args);

  const reply = (content: string) =>
    bot.helpers
      .sendMessage(message.channelId, {
        content,
        // Names people without pinging them, and never pings roles or @everyone
        // a moderator happened to type into a reason.
        allowedMentions: { parse: [] },
        messageReference: { messageId: message.id, failIfNotExists: false },
      })
      .catch((err) =>
        logger.warn("Couldn't reply to a moderation command", {
          guildId: message.guildId.toString(),
          channelId: message.channelId.toString(),
          detail: describeDiscordError(err).message,
        })
      );

  const targetId = parseUserId(parsed.target);
  if (!targetId) {
    await reply(`Who? Usage: ${usage(action, prefix)}`);
    return true;
  }

  const fetched = await getGuild(bot, message.guildId);
  if (!fetched) {
    await reply("I couldn't load this server's roles right now. Try again in a moment.");
    return true;
  }
  const guild: GuildInfo = {
    id: message.guildId,
    ownerId: fetched.ownerId,
    roles: [...fetched.roles.values()].map((r) => ({
      id: r.id,
      position: r.position,
      permissions: r.permissions?.bitfield ?? 0n,
    })),
  };

  const actorRoles = await bot.helpers.getMember(message.guildId, message.authorId).then((m) => m.roles).catch(() => null);
  if (!actorRoles) return true; // the author left between typing and now; nothing to answer
  // Unban and ban-by-id work on people who aren't in the server.
  const targetMember = await bot.helpers.getMember(message.guildId, targetId).catch(() => null);
  if (!targetMember && (action === "kick" || action === "mute" || action === "unmute")) {
    await reply("They aren't in this server.");
    return true;
  }

  const refusal = checkAction(
    guild,
    action,
    { id: message.authorId, roleIds: actorRoles },
    { id: targetId, roleIds: targetMember?.roles ?? null },
    bot.id,
    settings?.allowedRoleIds ?? [],
  );
  if (refusal) {
    await reply(refusalText(refusal));
    return true;
  }

  let durationMs = 0;
  if (action === "mute") {
    durationMs = parsed.durationMs ?? DEFAULT_MUTE_MS;
    if (durationMs > MAX_TIMEOUT_MS) {
      await reply("Discord's longest timeout is **28 days** (`28d`).");
      return true;
    }
  }
  if (action === "ban" && parsed.durationMs !== null) {
    durationMs = parsed.durationMs;
    if (durationMs > MAX_TEMPBAN_MS) {
      await reply("A ban with an end can last up to **a year** (`52w`). Leave the length out for a permanent ban.");
      return true;
    }
  }
  const reason = parsed.reason;
  // Shown in the server's audit log, so it says who used the command: the
  // audit log itself only shows Appealy.
  const auditReason = `${action} by ${message.authorId}${reason ? `: ${reason}` : ""}`.slice(0, 512);
  const who = `<@${targetId}>`;

  // Before the ban, because the appeal DM is sent from the ban event.
  if (action === "ban" && parsed.noAppeal) suppressNextAppeal(message.guildId, targetId);
  try {
    await run(bot, action, message.guildId, targetId, durationMs, auditReason);
  } catch (err) {
    if (action === "ban" && parsed.noAppeal) clearAppealSuppression(message.guildId, targetId);
    const info = describeDiscordError(err);
    logger.warn("Moderation command refused by Discord", {
      guildId: message.guildId.toString(),
      action,
      status: info.status,
      code: info.code,
      detail: info.message,
    });
    await reply(failureText(action, info.code));
    return true;
  }

  // A ban with an end gets its unban scheduled; a permanent one (or an unban)
  // clears any end left over from an earlier temporary ban.
  let scheduled = true;
  try {
    if (action === "ban" && durationMs > 0) {
      await scheduleUnban(message.guildId, targetId, new Date(Date.now() + durationMs), message.authorId);
    } else if (action === "ban" || action === "unban") {
      await cancelUnban(message.guildId, targetId);
    }
  } catch (err) {
    scheduled = false;
    logger.error("Couldn't store a temporary ban's end", { guildId: message.guildId.toString(), error: String(err) });
  }

  const because = reason ? ` · ${reason}` : "";
  const banLength = durationMs > 0 ? ` for **${formatDuration(durationMs)}**` : "";
  const banNotes = [
    parsed.noAppeal ? "no appeal" : "",
    durationMs > 0 && !scheduled ? "⚠️ couldn't schedule the unban: lift it by hand" : "",
  ].filter(Boolean).join(", ");
  await reply(
    {
      ban: `🔨 Banned ${who}${banLength}${because}${banNotes ? ` (${banNotes})` : ""}`,
      unban: `🔓 Unbanned ${who}${because}`,
      kick: `👢 Kicked ${who}${because}`,
      mute: `🔇 Timed out ${who} for **${formatDuration(durationMs)}**${because}`,
      unmute: `🔊 Removed the timeout on ${who}${because}`,
    }[action],
  );
  return true;
}

async function run(
  bot: AppealyBot,
  action: ModAction,
  guildId: bigint,
  userId: bigint,
  durationMs: number,
  reason: string,
) {
  switch (action) {
    case "ban":
      return await bot.helpers.banMember(guildId, userId, {}, reason);
    case "unban":
      return await bot.helpers.unbanMember(guildId, userId, reason);
    case "kick":
      return await bot.helpers.kickMember(guildId, userId, reason);
    case "mute":
      return await bot.helpers.editMember(
        guildId,
        userId,
        { communicationDisabledUntil: new Date(Date.now() + durationMs).toISOString() },
        reason,
      );
    case "unmute":
      return await bot.helpers.editMember(guildId, userId, { communicationDisabledUntil: null }, reason);
  }
}

function failureText(action: ModAction, code: number | null): string {
  if (code === 50013) {
    return "Discord refused: I'm missing the permission for that, or their highest role is above mine. Move Appealy's role higher in Server Settings → Roles.";
  }
  if (code === 10026 && action === "unban") return "They aren't banned.";
  if (code === 10007 || code === 10013) return "I couldn't find that user.";
  return "Discord refused that. Try again in a moment.";
}
