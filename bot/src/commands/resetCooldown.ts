// bot/src/commands/resetCooldown.ts
//
// /reset-cooldown <application_name> <user> [reason] — grants one applicant
// a one-time override past cooldown/standing-limit gating for one form,
// without touching their submission history. See shared/schema/gating.ts
// for exactly which checks the override does and doesn't bypass (role
// gates and pending-application checks are never bypassable this way,
// only throughput restrictions).

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq, and, like } from "drizzle-orm";
import { canReviewForm } from "../services/permissionService.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

const ADMINISTRATOR = 0x8n;

export const definition: CreateApplicationCommand = {
  name: "reset-cooldown",
  description: "Clear a user's cooldown/limit for one application form",
  type: ApplicationCommandTypes.ChatInput,
  // Discordeno takes permission NAMES here, not a bitfield string. The
  // old form type-checked against nothing and would have registered the
  // command with a permission value Discord could not parse.
  defaultMemberPermissions: ["ADMINISTRATOR"],
  options: [
    {
      name: "application_name",
      description: "The application form",
      type: ApplicationCommandOptionTypes.String,
      required: true,
      autocomplete: true,
    },
    { name: "user", description: "The user to reset", type: ApplicationCommandOptionTypes.User, required: true },
    { name: "reason", description: "Why this override is being granted", type: ApplicationCommandOptionTypes.String, required: false },
    {
      name: "expires_in_hours",
      description: "Override expires after N hours (default: never expires)",
      type: ApplicationCommandOptionTypes.Integer,
      required: false,
      minValue: 1,
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const staffMember = interaction.member?.user ?? interaction.user;
  if (!guildId || !staffMember) return;

  const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
  const formName = String(opts.application_name);
  const targetUserId = BigInt(String(opts.user));
  const reason = opts.reason ? String(opts.reason) : null;
  const expiresInHours = opts.expires_in_hours ? Number(opts.expires_in_hours) : null;

  // The form lookup, canReviewForm's permission check, and the upsert below
  // are several DB round trips — enough to blow Discord's three-second
  // first-response window. Deferring buys fifteen minutes.
  //
  // This only covers the `execute` handler. `autocomplete` below is a
  // separate interaction type (ApplicationCommandAutocomplete) that Discord
  // only accepts an immediate type: 8 response for — there is no deferred
  // variant for autocomplete, so it must keep responding to Discord
  // directly, the way both handlers did before this conversion. See the
  // dedicated guard test for this file in deferGuard.test.ts for why that
  // keeps it out of the generic MUST_DEFER list.
  await defer(bot, interaction, { ephemeral: true });

  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.guildId, guildId), eq(schema.forms.name, formName)),
  });
  if (!form) {
    return respond(bot, interaction, `No application found named **${formName}**.`);
  }

  const allowed = await canReviewForm(
    guildId,
    form.id,
    staffMember.id,
    interaction.member?.roles ?? [],
    interaction.member?.permissions?.bitfield ?? 0n,
  );
  if (!allowed) {
    return respond(bot, interaction, "You don't have permission to manage this application's applicants.");
  }

  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000) : null;

  await db
    .insert(schema.gateOverrides)
    .values({ formId: form.id, applicantId: targetUserId, grantedBy: staffMember.id, reason, expiresAt })
    .onConflictDoUpdate({
      target: [schema.gateOverrides.formId, schema.gateOverrides.applicantId],
      set: { grantedBy: staffMember.id, reason, expiresAt, createdAt: new Date() },
    });

  await respond(
    bot,
    interaction,
    `Cleared <@${targetUserId}>'s cooldown/limit for **${form.name}**${expiresAt ? ` (override expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>)` : ""}.`,
  );
}

export async function autocomplete(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const typed = String(interaction.data?.options?.[0]?.value ?? "");
  if (!guildId) return;

  const matches = await db
    .select({ name: schema.forms.name })
    .from(schema.forms)
    .where(and(eq(schema.forms.guildId, guildId), like(schema.forms.name, `%${typed}%`)))
    .limit(25);

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 8,
    data: { choices: matches.map((m) => ({ name: m.name, value: m.name })) },
  });
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change. NOT used by
// autocomplete() above — that handler must keep responding directly (see
// the comment on the defer() call in execute()).
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
