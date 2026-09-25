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
import { CUSTOM_ID_NAMESPACES, encodeCustomId } from "../../../shared/types/index.ts";

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

  // A notice with a button, NOT the first question.
  //
  // This used to call startDmApplication directly, so someone banned at 3am
  // got "Question 1/5: why should we unban you?" seconds later, before they
  // had worked out what had even happened. That reads as an interrogation,
  // and it assumes everyone wants to appeal — most people just want to know
  // what they were banned from. Appealing is now something they choose.
  //
  // The roles argument is gone from this path entirely: nothing is started
  // here. When the button is clicked, appealStart.ts passes an empty array,
  // because a banned user is definitionally not a member and an appeal form
  // with requiredRoleIds set would otherwise gate out every appellant.
  const guild = await db.query.guilds.findFirst({
    where: eq(schema.guilds.id, guildId),
    columns: { name: true },
  });

  const notice = config.dmOnBanNote?.trim()
    ? config.dmOnBanNote
    : `You have been banned from **${guild?.name ?? "a server"}**.`;

  const { dmOrLog } = await import("../services/dmApplicationService.ts");
  const sent = await dmOrLog(bot, bannedUserId, notice, [
    {
      type: 1, // action row
      components: [
        {
          type: 2, // button
          style: 1, // primary
          label: "Appeal this ban",
          customId: encodeCustomId(
            CUSTOM_ID_NAMESPACES.APPEAL,
            "start",
            guildId.toString(),
            form.id,
          ),
        },
      ],
    },
  ]);

  logger.info("Sent (or attempted) ban notice with appeal button", {
    guildId: guildId.toString(),
    userId: bannedUserId.toString(),
    formId: form.id,
    delivered: sent,
  });
}
