// bot/src/services/moderation.ts
//
// Runs the text moderation commands parsed in services/modCommands.ts:
// ?ban, ?unban, ?kick, ?mute, ?unmute (and "@Appealy ban …").
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
import { describeDiscordError } from "../utils/discordError.ts";
import { logger } from "../utils/logger.ts";
import {
  checkAction,
  formatDuration,
  type GuildInfo,
  MAX_TIMEOUT_MS,
  type ModAction,
  parseDuration,
  parseModCommand,
  parseUserId,
  refusalText,
  USAGE,
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
export async function handleModerationCommand(bot: AppealyBot, message: CommandMessage): Promise<boolean> {
  const command = parseModCommand(message.content, bot.id);
  if (!command) return false;
  const { action, args } = command;

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

  const targetId = parseUserId(args[0]);
  if (!targetId) {
    await reply(`Who? Usage: ${USAGE[action]}`);
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
  );
  if (refusal) {
    await reply(refusalText(refusal));
    return true;
  }

  let rest = args.slice(1);
  let durationMs = 0;
  if (action === "mute") {
    const parsed = parseDuration(rest[0]);
    if (parsed !== null) rest = rest.slice(1);
    durationMs = parsed ?? DEFAULT_MUTE_MS;
    if (durationMs > MAX_TIMEOUT_MS) {
      await reply("Discord's longest timeout is **28 days** (`28d`).");
      return true;
    }
  }
  const reason = rest.join(" ").slice(0, 400) || null;
  // Shown in the server's audit log, so it says who used the command: the
  // audit log itself only shows Appealy.
  const auditReason = `${action} by ${message.authorId}${reason ? `: ${reason}` : ""}`.slice(0, 512);
  const who = `<@${targetId}>`;

  try {
    await run(bot, action, message.guildId, targetId, durationMs, auditReason);
  } catch (err) {
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

  const because = reason ? ` · ${reason}` : "";
  await reply(
    {
      ban: `🔨 Banned ${who}${because}`,
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
