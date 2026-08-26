// bot/src/interactions/selects/roleMenuSelect.ts
//
// Handles a member's selection on a self-assignable role menu. Diffs their
// chosen role IDs against the menu's known option roles they currently
// hold, then grants/removes only what changed — never touches roles the
// member has that aren't part of this menu.

import { eq } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../../core/client.ts";

import type { AppealyBot } from "../../core/client.ts";
import { db, schema } from "../../db/client.ts";
import { findUnmanageableRoles } from "../../services/permissionService.ts";
import { logger } from "../../utils/logger.ts";
import { defer, finish } from "../../utils/interactionResponse.ts";

export async function handleRoleMenuSelect(bot: AppealyBot, interaction: Interaction, menuId: string) {
  const guildId = interaction.guildId;
  const member = interaction.member;
  const user = member?.user ?? interaction.user;
  if (!guildId || !member || !user) return;

  // A menu lookup, an unmanageable-roles check, then a grant/remove REST
  // call per changed role — enough sequential work to blow the window on a
  // menu with several options selected at once.
  await defer(bot, interaction, { ephemeral: true });

  const menu = await db.query.roleMenus.findFirst({
    where: eq(schema.roleMenus.id, menuId),
    with: { options: true },
  });
  if (!menu) return respond(bot, interaction, "This role menu no longer exists.");

  const menuRoleIds = menu.options.map((o) => o.roleId.toString());
  const selectedRoleIds = new Set((interaction.data?.values ?? []).map(String));
  const currentMenuRoleIds = new Set(member.roles.map(String).filter((r) => menuRoleIds.includes(r)));

  const toGrant = [...selectedRoleIds].filter((r) => !currentMenuRoleIds.has(r));
  const toRemove = [...currentMenuRoleIds].filter((r) => !selectedRoleIds.has(r));

  const unmanageable = await findUnmanageableRoles(bot, guildId, [...toGrant, ...toRemove]);
  const manageableGrant = toGrant.filter((r) => !unmanageable.includes(r));
  const manageableRemove = toRemove.filter((r) => !unmanageable.includes(r));

  try {
    for (const roleId of manageableGrant) {
      await bot.helpers.addRole(guildId, user.id, BigInt(roleId), "Self-assigned via role menu");
    }
    for (const roleId of manageableRemove) {
      await bot.helpers.removeRole(guildId, user.id, BigInt(roleId), "Self-removed via role menu");
    }
  } catch (err) {
    logger.error("Role menu role update failed", { menuId, error: String(err) });
    return respond(bot, interaction, "Something went wrong updating your roles. Please try again.");
  }

  const message =
    unmanageable.length > 0
      ? "Your roles were updated, but one or more selections couldn't be applied — please contact staff."
      : "Your roles have been updated.";
  await respond(bot, interaction, message);
}

// Kept as a one-line wrapper rather than rewriting every call site: the
// ephemeral flag now lives on the deferral, so there is nothing left for
// this to decide.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
