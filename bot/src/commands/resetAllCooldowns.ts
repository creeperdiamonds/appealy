// bot/src/commands/resetAllCooldowns.ts
//
// /reset-all-cooldowns <application_name> — /reset-cooldown for everyone at
// once. Sets forms.gateResetAt to now: submissions from before it stop
// counting toward the form's cooldown and submission limits, so anyone can
// apply again right away while the cooldown itself stays switched on for what
// comes next. Like the per-user override it bypasses only those throughput
// checks (see gateCountingFrom in shared/schema/gating.ts): role gates, the
// one-pending rule and an inactive form still apply. No submission is changed
// or deleted, so exports and history stay whole.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq, and } from "drizzle-orm";
import { canReviewForm } from "../services/permissionService.ts";
import { defer, finish } from "../utils/interactionResponse.ts";
import { logger } from "../utils/logger.ts";

// Same form-name suggestions as /reset-cooldown: its first option is the form
// name too. Re-exported so commands/index.ts routes autocomplete here.
export { autocomplete } from "./resetCooldown.ts";

export const definition: CreateApplicationCommand = {
  name: "reset-all-cooldowns",
  description: "Clear the cooldown/limit for everyone on one application form",
  descriptionLocalizations: { ja: "応募フォームのクールダウンや制限を全員分まとめて解除します" },
  type: ApplicationCommandTypes.ChatInput,
  defaultMemberPermissions: ["ADMINISTRATOR"],
  options: [
    {
      name: "application_name",
      description: "The application form",
      descriptionLocalizations: { ja: "対象の応募フォーム" },
      type: ApplicationCommandOptionTypes.String,
      required: true,
      autocomplete: true,
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const staffMember = interaction.member?.user ?? interaction.user;
  if (!guildId || !staffMember) return;

  const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
  const formName = String(opts.application_name);

  // Form lookup, permission check and the update are several DB round trips.
  await defer(bot, interaction, { ephemeral: true });

  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.guildId, guildId), eq(schema.forms.name, formName)),
  });
  if (!form) {
    return finish(bot, interaction, `No application found named **${formName}**.`);
  }

  const allowed = await canReviewForm(
    guildId,
    form.id,
    staffMember.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions?.bitfield ?? 0n,
  );
  if (!allowed) {
    return finish(bot, interaction, "You don't have permission to manage this application's applicants.");
  }

  await db
    .update(schema.forms)
    .set({ gateResetAt: new Date(), gateResetBy: staffMember.id })
    .where(eq(schema.forms.id, form.id));

  logger.info("Form cooldowns reset for everyone", {
    guildId: String(guildId),
    formId: form.id,
    by: String(staffMember.id),
  });
  await finish(
    bot,
    interaction,
    `Cleared the cooldown and submission limits for **everyone** on **${form.name}**. ` +
      "Anyone can apply again now; the cooldown still applies from their next application. " +
      "People with a pending application still need it decided first.",
  );
}
