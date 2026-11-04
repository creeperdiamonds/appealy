// bot/src/services/moderation.ts
//
// Runs the moderation commands: /ban, /unban, /kick, /mute and /unmute
// (commands/moderation.ts), and the same commands typed as a mention,
// "@Appealy ban …" (parsed in services/modCommands.ts). Both end in
// moderate(), so they check and do exactly the same things. Each server can
// limit them to roles, and turn the mention form off, on the dashboard's
// Moderation page (moderation_configs).
//
// Appeals come for free: a ban or a timeout made here fires the same gateway
// events as one made in Discord's own menu, so events/guildBanAdd.ts and the
// timeout trigger send the appeal button exactly as they always have.
//
// Only reached for a command, so the extra requests here (the moderator, the
// target, the guild) are per command, never per message.

import type { AppealyBot } from "../core/client.ts";
import { deployment } from "../core/env.ts";
import { getGuild } from "../core/guildLookup.ts";
import { getGuildConfig } from "../core/guildConfigCache.ts";
import { clearAppealSuppression, suppressNextAppeal } from "./appealSuppression.ts";
import { cancelUnban, scheduleUnban } from "./tempBans.ts";
import { describeDiscordError } from "../utils/discordError.ts";
import { logger } from "../utils/logger.ts";
import {
  checkAction,
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

/** Without a duration, a mute lasts an hour, which it says in its reply. */
const DEFAULT_MUTE_MS = 3_600_000;

export interface CommandMessage {
  id: bigint;
  channelId: bigint;
  guildId: bigint;
  authorId: bigint;
  content: string;
}

/**
 * Whether a message could be a command, without any I/O: the cheap test
 * messageCreate runs before calling handleModerationCommand. A command starts
 * by mentioning the bot, so nearly every message stops at its first two
 * characters.
 */
export function mightBeCommand(content: string): boolean {
  return content.startsWith("<@");
}

/** True when the message was a moderation command (handled, or refused). */
export async function handleModerationCommand(bot: AppealyBot, message: CommandMessage): Promise<boolean> {
  const command = parseModCommand(message.content, bot.id);
  if (!command) return false;
  const settings = (await getGuildConfig(message.guildId)).moderation;
  // Turned off on the dashboard. The slash commands aren't affected: a server
  // turns those off in Discord's own Integrations settings.
  if (settings && !settings.textCommandsEnabled) return false;

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
    await reply(`Who? Usage: ${usage(action, deployment.brandName)}, or use /${action}.`);
    return true;
  }

  const actorRoles = await bot.helpers.getMember(message.guildId, message.authorId).then((m) => m.roles).catch(() => null);
  if (!actorRoles) return true; // the author left between typing and now; nothing to answer

  const text = await moderate(bot, {
    guildId: message.guildId,
    actorId: message.authorId,
    actorRoles,
    action,
    targetId,
    durationMs: parsed.durationMs,
    noAppeal: parsed.noAppeal,
    reason: parsed.reason,
  });
  await reply(text);
  return true;
}

export interface ModerationRequest {
  guildId: bigint;
  actorId: bigint;
  /** The moderator's roles, from the interaction or a member lookup. */
  actorRoles: bigint[];
  action: ModAction;
  targetId: bigint;
  /** A length for a mute or a temporary ban; null when none was given. */
  durationMs: number | null;
  /** Ban without sending the appeal button. Ban only. */
  noAppeal: boolean;
  reason: string | null;
}

/**
 * Checks and carries out one moderation action. Returns what to tell the
 * moderator, whether it worked or why it didn't; it never throws for
 * something Discord refused.
 */
export async function moderate(bot: AppealyBot, req: ModerationRequest): Promise<string> {
  const { guildId, actorId, action, targetId, noAppeal, reason } = req;
  const settings = (await getGuildConfig(guildId)).moderation;

  const fetched = await getGuild(bot, guildId);
  if (!fetched) return "I couldn't load this server's roles right now. Try again in a moment.";
  const guild: GuildInfo = {
    id: guildId,
    ownerId: fetched.ownerId,
    roles: [...fetched.roles.values()].map((r) => ({
      id: r.id,
      position: r.position,
      permissions: r.permissions?.bitfield ?? 0n,
    })),
  };

  // Unban and ban-by-id work on people who aren't in the server.
  const targetMember = await bot.helpers.getMember(guildId, targetId).catch(() => null);
  if (!targetMember && (action === "kick" || action === "mute" || action === "unmute")) {
    return "They aren't in this server.";
  }

  const refusal = checkAction(
    guild,
    action,
    { id: actorId, roleIds: req.actorRoles },
    { id: targetId, roleIds: targetMember?.roles ?? null },
    bot.id,
    settings?.allowedRoleIds ?? [],
  );
  if (refusal) return refusalText(refusal);

  let durationMs = 0;
  if (action === "mute") {
    durationMs = req.durationMs ?? DEFAULT_MUTE_MS;
    if (durationMs > MAX_TIMEOUT_MS) return "Discord's longest timeout is **28 days** (`28d`).";
  }
  if (action === "ban" && req.durationMs !== null) {
    durationMs = req.durationMs;
    if (durationMs > MAX_TEMPBAN_MS) {
      return "A ban with an end can last up to **a year** (`52w`). Leave the length out for a permanent ban.";
    }
  }
  // Shown in the server's audit log, so it says who used the command: the
  // audit log itself only shows Appealy.
  const auditReason = `${action} by ${actorId}${reason ? `: ${reason}` : ""}`.slice(0, 512);
  const who = `<@${targetId}>`;

  // Before the ban, because the appeal DM is sent from the ban event.
  if (action === "ban" && noAppeal) suppressNextAppeal(guildId, targetId);
  try {
    await run(bot, action, guildId, targetId, durationMs, auditReason);
  } catch (err) {
    if (action === "ban" && noAppeal) clearAppealSuppression(guildId, targetId);
    const info = describeDiscordError(err);
    logger.warn("Moderation command refused by Discord", {
      guildId: guildId.toString(),
      action,
      status: info.status,
      code: info.code,
      detail: info.message,
    });
    return failureText(action, info.code);
  }

  // A ban with an end gets its unban scheduled; a permanent one (or an unban)
  // clears any end left over from an earlier temporary ban.
  let scheduled = true;
  try {
    if (action === "ban" && durationMs > 0) {
      await scheduleUnban(guildId, targetId, new Date(Date.now() + durationMs), actorId);
    } else if (action === "ban" || action === "unban") {
      await cancelUnban(guildId, targetId);
    }
  } catch (err) {
    scheduled = false;
    logger.error("Couldn't store a temporary ban's end", { guildId: guildId.toString(), error: String(err) });
  }

  const because = reason ? ` · ${reason}` : "";
  const banLength = durationMs > 0 ? ` for **${formatDuration(durationMs)}**` : "";
  const banNotes = [
    noAppeal ? "no appeal" : "",
    durationMs > 0 && !scheduled ? "⚠️ couldn't schedule the unban: lift it by hand" : "",
  ].filter(Boolean).join(", ");
  return {
    ban: `🔨 Banned ${who}${banLength}${because}${banNotes ? ` (${banNotes})` : ""}`,
    unban: `🔓 Unbanned ${who}${because}`,
    kick: `👢 Kicked ${who}${because}`,
    mute: `🔇 Timed out ${who} for **${formatDuration(durationMs)}**${because}`,
    unmute: `🔊 Removed the timeout on ${who}${because}`,
  }[action];
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
