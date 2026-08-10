// bot/src/events/guildBanAdd.ts
//
// Fires when a member is banned from a guild — the entry point for
// "Appealy's Appealable Appealing Appeal System" (see
// shared/schema/schema.ts's appealConfigs comment for the full design and
// its DM-delivery reliability caveat, which applies to everything below).
//
// Requires the GuildModeration gateway intent (see bot/src/core/client.ts).

import { eq, and } from "drizzle-orm";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { logger } from "../utils/logger.ts";

export function onGuildBanAdd(bot: AppealyBot) {
  return async (payload: { guildId: bigint; user: { id: bigint; username?: string } }) => {
    try {
      await sendBanAppealDm(bot, payload.guildId, payload.user.id);
    } catch (err) {
      // Never let a failure here take down the gateway event loop —
      // ban-appeal delivery is best-effort by design (see the schema
      // comment), not a guarantee.
      logger.error("Failed while handling guildBanAdd for ban appeals", {
        guildId: payload.guildId.toString(),
        userId: payload.user.id.toString(),
        error: String(err),
      });
    }
  };
}

async function sendBanAppealDm(bot: AppealyBot, guildId: bigint, bannedUserId: bigint) {
  const config = await db.query.appealConfigs.findFirst({ where: eq(schema.appealConfigs.guildId, guildId) });
  if (!config || !config.enabled || !config.dmOnBanEnabled || !config.formId) return;

  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, config.formId), eq(schema.forms.guildId, guildId)),
    with: { questions: { orderBy: (q, { asc }) => [asc(q.sortOrder)] } },
  });

  if (!form || !form.active) {
    logger.warn("appealConfigs.formId points at a missing or inactive form — skipping ban-appeal DM", {
      guildId: guildId.toString(),
      formId: config.formId,
    });
    return;
  }
  if (form.kind !== "appeal" || form.applicationType !== "direct_message") {
    // Guarded at write time (api/src/routes/forms.ts, api/src/routes/appealConfig.ts)
    // but re-checked here rather than trusted blindly, same principle as
    // the regex-safety re-check described in README.md's "Regex answer
    // validation" section — never trust a stored reference as pre-vetted
    // just because it passed validation once at write time.
    logger.warn("appealConfigs.formId does not point at a direct_message appeal-kind form — skipping ban-appeal DM", {
      guildId: guildId.toString(),
      formId: config.formId,
    });
    return;
  }

  const { startDmApplication } = await import("../services/dmApplicationService.ts");
  // Banned users are, definitionally, not currently a guild member — there
  // are no roles to evaluate. An appeal form with requiredRoleIds/
  // blacklistedRoleIds configured would gate out every single appellant,
  // which is almost certainly not what an admin who set that up intended;
  // the dashboard's appeal-form editor should warn against setting those
  // fields on an appeal-kind form, but a functionally-empty array is
  // passed through here regardless of what the form asks for.
  await startDmApplication(bot, guildId, form, bannedUserId, [], config.dmOnBanNote ?? undefined);

  logger.info("Sent (or attempted) ban-appeal DM", { guildId: guildId.toString(), userId: bannedUserId.toString(), formId: form.id });
}
