// bot/src/services/permissionService.ts
//
// Two distinct permission questions live here:
//   1. Can this staff member review submissions for this form at all?
//      (Administrator OR explicit manager delegation via staff_permissions)
//   2. Can the bot actually assign/remove the roles this form specifies?
//      (bot's highest role position must be above every target role, per
//      Discord's role hierarchy rules — otherwise the API call 403s)

import { eq, and, or, isNull } from "drizzle-orm";
import { getGuild } from "../core/guildLookup.ts";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { STAFF_RANK, type StaffLevel } from "../../../shared/schema/outcomes.ts";

const ADMINISTRATOR = 0x8n;

/**
 * True only for the guild's actual owner — stricter than any permission
 * bit, since Administrator does not imply ownership. Used to gate the
 * full-data /export and /import-appy commands, matching the same
 * owner-only scoping as the dashboard's requireOwnerAccess middleware
 * (api/src/middleware/guildAccess.ts) so both entry points enforce the
 * identical rule rather than two independently-maintained checks that
 * could drift apart.
 */
export async function isGuildOwner(bot: AppealyBot, guildId: bigint, userId: bigint): Promise<boolean> {
  // Fetched live, never inferred. A wrong answer here is a real trust
  // boundary, not a cosmetic one, so this deliberately does not fall back to
  // anything when the fetch fails — it throws and the caller refuses.
  const guild = await getGuild(bot, guildId);
  if (!guild) throw new Error(`Cannot verify ownership: guild ${guildId} unreachable`);
  return guild.ownerId === userId;
}

export async function canReviewForm(
  guildId: bigint,
  formId: string,
  memberId: bigint,
  memberRoleIds: bigint[],
  memberPermissions: bigint,
): Promise<boolean> {
  if ((memberPermissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

  const delegations = await db
    .select()
    .from(schema.staffPermissions)
    .where(
      and(
        eq(schema.staffPermissions.guildId, guildId),
        or(isNull(schema.staffPermissions.formId), eq(schema.staffPermissions.formId, formId)),
        eq(schema.staffPermissions.canReview, true),
      ),
    );

  return delegations.some(
    (d) =>
      (d.userId !== null && d.userId === memberId) ||
      (d.roleId !== null && memberRoleIds.includes(d.roleId)),
  );
}

/**
 * The reviewer's highest staff level, for outcome gating.
 *
 * Separate from canReviewForm because they answer different questions: that
 * one is "may you review at all", this is "how far up the outcome list do you
 * reach". Collapsing them would mean any reviewer can grant any outcome, which
 * turns the application form into a privilege escalation path — see
 * shared/schema/outcomes.ts.
 *
 * Discord ADMINISTRATOR maps to "owner" deliberately. Someone with that
 * permission can already assign any role by hand; pretending the bot restricts
 * them would be theatre, and worse, it would hide a real outcome from someone
 * who genuinely has the authority to grant it.
 */
export async function staffLevelFor(
  guildId: bigint,
  memberId: bigint,
  memberRoleIds: bigint[],
  memberPermissions: bigint = 0n,
): Promise<StaffLevel> {
  if ((memberPermissions & ADMINISTRATOR) === ADMINISTRATOR) return "owner";

  const rows = await db
    .select()
    .from(schema.staffPermissions)
    .where(eq(schema.staffPermissions.guildId, guildId));

  const mine = rows.filter(
    (d) =>
      (d.userId !== null && d.userId === memberId) ||
      (d.roleId !== null && memberRoleIds.includes(d.roleId)),
  );

  // Highest wins. Someone holding both a manager delegation and an admin one
  // through different roles is an admin.
  let best: StaffLevel = "manager";
  for (const d of mine) {
    if (STAFF_RANK[d.level as StaffLevel] > STAFF_RANK[best]) best = d.level as StaffLevel;
  }
  return best;
}

export async function canManageForm(
  guildId: bigint,
  formId: string | null,
  memberId: bigint,
  memberRoleIds: bigint[],
  memberPermissions: bigint,
): Promise<boolean> {
  if ((memberPermissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

  const delegations = await db
    .select()
    .from(schema.staffPermissions)
    .where(
      and(
        eq(schema.staffPermissions.guildId, guildId),
        formId
          ? or(isNull(schema.staffPermissions.formId), eq(schema.staffPermissions.formId, formId))
          : isNull(schema.staffPermissions.formId),
        eq(schema.staffPermissions.canManageForm, true),
      ),
    );

  return delegations.some(
    (d) =>
      (d.userId !== null && d.userId === memberId) ||
      (d.roleId !== null && memberRoleIds.includes(d.roleId)),
  );
}

export async function canManageTicket(
  guildId: bigint,
  config: { supportRoleIds: string[] },
  memberId: bigint,
  memberRoleIds: bigint[],
  memberPermissions: bigint,
): Promise<boolean> {
  if ((memberPermissions & ADMINISTRATOR) === ADMINISTRATOR) return true;
  return config.supportRoleIds.some((roleId) => memberRoleIds.map(String).includes(roleId));
}

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

  const guild = await bot.helpers.getGuild(guildId);
  const botMember = await bot.helpers.getMember(guildId, bot.id);

  const botRoles = guild.roles.filter((r) => botMember.roles.includes(r.id));
  const botHighestPosition = Math.max(0, ...botRoles.map((r) => r.position));

  const unmanageable: string[] = [];
  for (const roleId of roleIds) {
    const role = guild.roles.find((r) => r.id === BigInt(roleId));
    if (!role) continue; // role no longer exists — nothing to manage
    if (role.position >= botHighestPosition) {
      unmanageable.push(roleId);
    }
  }
  return unmanageable;
}
