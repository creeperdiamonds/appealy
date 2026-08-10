// bot/src/commands/verifySetup.ts
// /verify-setup — configures and publishes the verification panel.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { Interaction, CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { publishVerificationPanel } from "../services/verificationPanelService.ts";

const ADMINISTRATOR = 0x8n;
const EPHEMERAL = 64;

export const definition: CreateApplicationCommand = {
  name: "verify-setup",
  description: "Configure and publish server verification",
  type: ApplicationCommandTypes.ChatInput,
  defaultMemberPermissions: ADMINISTRATOR.toString(),
  options: [
    { name: "verified_role", description: "Role granted upon verification", type: ApplicationCommandOptionTypes.Role, required: true },
    { name: "method", description: "Verification method", type: ApplicationCommandOptionTypes.String, required: false, choices: [
      { name: "Single button", value: "button" },
      { name: "Retype-code captcha", value: "captcha" },
    ] },
    { name: "unverified_role", description: "Role applied on join, removed on verify (optional gate role)", type: ApplicationCommandOptionTypes.Role, required: false },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  if (!guildId || !channelId) return;

  const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
  const verifiedRoleId = BigInt(String(opts.verified_role));
  const method = (opts.method as string) ?? "button";
  const unverifiedRoleId = opts.unverified_role ? BigInt(String(opts.unverified_role)) : null;

  await db
    .insert(schema.verificationConfigs)
    .values({
      guildId,
      enabled: true,
      channelId,
      method: method as "button" | "captcha",
      verifiedRoleId,
      unverifiedRoleId,
    })
    .onConflictDoUpdate({
      target: schema.verificationConfigs.guildId,
      set: { enabled: true, channelId, method: method as "button" | "captcha", verifiedRoleId, unverifiedRoleId, updatedAt: new Date() },
    });

  await publishVerificationPanel(bot, guildId);

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content: "Verification panel published.", flags: EPHEMERAL },
  });
}
