// bot/src/services/roleHierarchy.ts
//
// Whether the bot can actually assign or remove a role. Kept out of
// permissionService.ts, which re-exports it, because that file opens the database
// and this only needs what Discord says, so it can be tested without one.

import type { AppealyBot } from "../core/client.ts";
import { isSnowflake } from "../../../shared/lib/snowflake.ts";

/**
 * Verifies the bot's own highest role sits above every role it needs to
 * grant/remove, per Discord's role hierarchy rule (a bot/member can only
 * manage roles positioned below its own highest role). Returns the subset
 * of role IDs the bot is NOT able to manage, so the caller can warn staff
 * precisely rather than failing silently.
 */
export async function findUnmanageableRoles(
  bot: AppealyBot,
  guildId: bigint,
  roleIds: string[],
): Promise<string[]> {
  if (roleIds.length === 0) return [];

  // A role saved as text rather than an ID can't be managed by anyone. Reporting
  // it keeps it away from the BigInt() every caller runs on what's left, which
  // would otherwise throw in the middle of accepting or denying an application.
  const notIds = roleIds.filter((id) => !isSnowflake(id));
  const ids = roleIds.filter((id) => isSnowflake(id));
  if (ids.length === 0) return notIds;

  const guild = await bot.helpers.getGuild(guildId);
  const botMember = await bot.helpers.getMember(guildId, bot.id);

  const botRoles = guild.roles.filter((r) => botMember.roles.includes(r.id));
  const botHighestPosition = Math.max(0, ...botRoles.map((r) => r.position));

  // Order alone isn't enough: without Manage Roles every role is out of reach,
  // and the call for it fails with a bare "Missing Permissions". That's the
  // state top.gg reviews bots in: added with no role and no extra permissions.
  // The @everyone role shares the guild's id and counts too.
  const everyone = guild.roles.find((r) => r.id === guildId);
  // botRoles is a Collection: spread as-is it gives [id, role] pairs.
  const canManageRoles = [everyone, ...botRoles.values()].some(
    (r) => r?.permissions?.has("ADMINISTRATOR") || r?.permissions?.has("MANAGE_ROLES"),
  );
  if (!canManageRoles) {
    return [...notIds, ...ids.filter((id) => guild.roles.some((r) => r.id === BigInt(id)))];
  }

  const unmanageable = [...notIds];
  for (const roleId of ids) {
    const role = guild.roles.find((r) => r.id === BigInt(roleId));
    if (!role) continue; // role no longer exists — nothing to manage
    if (role.position >= botHighestPosition) {
      unmanageable.push(roleId);
    }
  }
  return unmanageable;
}
