// bot/src/services/modCommands.ts
//
// The text side of the moderation commands: ?ban, ?unban, ?kick, ?mute and
// ?unmute, also written "@Appealy ban …".
//
// WHY TEXT COMMANDS
//
// Dyno and others retired theirs, and plenty of moderators still prefer
// typing "?ban @user spamming" to filling in a slash command. They need the
// Message Content intent, which Discord grants freely below 100 servers and
// refuses for prefix commands after verification at 100. So every command
// also works by mentioning the bot ("@Appealy ban @user spamming"): Discord
// always delivers the content of messages that mention a bot, intent or not.
// If the intent ever goes, "?" stops and "@Appealy" carries on.
//
// Free of env and network so it can be tested; services/moderation.ts runs
// the commands.

export const PREFIX = "?";

export type ModAction = "ban" | "unban" | "kick" | "mute" | "unmute";

const ALIASES: Record<string, ModAction> = {
  ban: "ban",
  unban: "unban",
  kick: "kick",
  mute: "mute",
  timeout: "mute",
  unmute: "unmute",
  untimeout: "unmute",
};

export interface ParsedCommand {
  action: ModAction;
  /** Everything after the command word, split on whitespace. */
  args: string[];
}

/**
 * The command in a message, or null when the message isn't one. Cheap on the
 * common path: anything not starting with the prefix or a mention is
 * rejected before any splitting.
 */
export function parseModCommand(content: string, botId: bigint): ParsedCommand | null {
  const text = content.trim();
  let rest: string;
  if (text.startsWith(PREFIX)) {
    rest = text.slice(PREFIX.length);
  } else if (text.startsWith("<@")) {
    const m = /^<@!?(\d{17,20})>\s*/.exec(text);
    if (!m || BigInt(m[1]) !== botId) return null;
    rest = text.slice(m[0].length);
  } else {
    return null;
  }
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const action = ALIASES[(words[0] ?? "").toLowerCase()];
  if (!action) return null;
  return { action, args: words.slice(1) };
}

/** A user from a mention (<@id> or <@!id>) or a bare id; null otherwise. */
export function parseUserId(token: string | undefined): bigint | null {
  if (!token) return null;
  const m = /^<@!?(\d{17,20})>$/.exec(token) ?? /^(\d{17,20})$/.exec(token);
  return m ? BigInt(m[1]) : null;
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Discord's longest timeout: 28 days. */
export const MAX_TIMEOUT_MS = 28 * UNIT_MS.d;

/**
 * "10m", "1h30m", "2d", "1w" → milliseconds; null when it isn't a duration.
 * Not clamped: the caller says when it's over the 28-day limit rather than
 * quietly shortening it.
 */
export function parseDuration(token: string | undefined): number | null {
  if (!token) return null;
  const text = token.toLowerCase();
  if (!/^(\d+[smhdw])+$/.test(text)) return null;
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)([smhdw])/g)) total += Number(n) * UNIT_MS[unit];
  return total > 0 ? total : null;
}

/** 90 minutes → "1h 30m". */
export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let left = Math.round(ms / 1000);
  for (const [unit, secs] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    const n = Math.floor(left / secs);
    if (n) parts.push(`${n}${unit}`);
    left -= n * secs;
  }
  return parts.join(" ") || "0s";
}

// ------------------------------------------------------------ permissions ----

export const PERM = {
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;

/** What each action needs from the person running it. */
export const NEEDS: Record<ModAction, { bit: bigint; name: string }> = {
  ban: { bit: PERM.BAN_MEMBERS, name: "Ban Members" },
  unban: { bit: PERM.BAN_MEMBERS, name: "Ban Members" },
  kick: { bit: PERM.KICK_MEMBERS, name: "Kick Members" },
  mute: { bit: PERM.MODERATE_MEMBERS, name: "Timeout Members" },
  unmute: { bit: PERM.MODERATE_MEMBERS, name: "Timeout Members" },
};

export interface RoleInfo {
  id: bigint;
  position: number;
  permissions: bigint;
}

export interface GuildInfo {
  id: bigint;
  ownerId: bigint;
  roles: RoleInfo[];
}

/** A member's server-wide permissions, the way Discord adds them up. */
export function memberPermissions(guild: GuildInfo, userId: bigint, roleIds: bigint[]): bigint {
  if (userId === guild.ownerId) return ~0n;
  // @everyone's role id is the guild's own id.
  let bits = guild.roles.find((r) => r.id === guild.id)?.permissions ?? 0n;
  for (const r of guild.roles) if (roleIds.includes(r.id)) bits |= r.permissions;
  return bits & PERM.ADMINISTRATOR ? ~0n : bits;
}

/** The position of a member's highest role (0 for @everyone only). */
export function topPosition(guild: GuildInfo, roleIds: bigint[]): number {
  let top = 0;
  for (const r of guild.roles) if (roleIds.includes(r.id) && r.position > top) top = r.position;
  return top;
}

export type Refusal =
  | { reason: "missing_permission"; permission: string }
  | { reason: "self" }
  | { reason: "owner" }
  | { reason: "bot" }
  | { reason: "hierarchy" };

/**
 * Whether the person running the command may do it to the target. Discord
 * itself only checks Appealy's own role against the target's, so the
 * moderator's is checked here: without it, anyone with Ban Members could ban
 * someone ranked above them through the bot.
 *
 * targetRoleIds is null when the target isn't in the server (a ban by id, or
 * an unban); there is no rank to compare then.
 */
export function checkAction(
  guild: GuildInfo,
  action: ModAction,
  actor: { id: bigint; roleIds: bigint[] },
  target: { id: bigint; roleIds: bigint[] | null },
  botId: bigint,
): Refusal | null {
  const need = NEEDS[action];
  if (!(memberPermissions(guild, actor.id, actor.roleIds) & need.bit)) {
    return { reason: "missing_permission", permission: need.name };
  }
  if (target.id === actor.id) return { reason: "self" };
  if (target.id === botId) return { reason: "bot" };
  if (target.id === guild.ownerId) return { reason: "owner" };
  if (target.roleIds && actor.id !== guild.ownerId) {
    if (topPosition(guild, target.roleIds) >= topPosition(guild, actor.roleIds)) return { reason: "hierarchy" };
  }
  return null;
}

export function refusalText(r: Refusal): string {
  switch (r.reason) {
    case "missing_permission":
      return `You need the **${r.permission}** permission for that.`;
    case "self":
      return "You can't do that to yourself.";
    case "bot":
      return "I can't do that to myself.";
    case "owner":
      return "The server owner can't be moderated.";
    case "hierarchy":
      return "Their highest role is the same as or above yours.";
  }
}

export const USAGE: Record<ModAction, string> = {
  ban: "`?ban @user [reason]`",
  unban: "`?unban <user id> [reason]`",
  kick: "`?kick @user [reason]`",
  mute: "`?mute @user [duration, e.g. 10m, 2h, 1d] [reason]`",
  unmute: "`?unmute @user [reason]`",
};
