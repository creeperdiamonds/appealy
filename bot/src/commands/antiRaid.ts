// bot/src/commands/antiRaid.ts
// /anti-raid setup|clear|status

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { Interaction, CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { clearLockdown, isLockdownActive } from "../services/antiRaidService.ts";

const ADMINISTRATOR = 0x8n;
const EPHEMERAL = 64;

export const definition: CreateApplicationCommand = {
  name: "anti-raid",
  description: "Configure join-velocity raid detection",
  type: ApplicationCommandTypes.ChatInput,
  defaultMemberPermissions: ADMINISTRATOR.toString(),
  options: [
    {
      name: "setup",
      description: "Configure raid detection thresholds and response",
      type: ApplicationCommandOptionTypes.SubCommand,
      options: [
        { name: "join_threshold", description: "Trigger if this many members join within the window", type: ApplicationCommandOptionTypes.Integer, required: true, minValue: 3 },
        { name: "window_seconds", description: "Time window in seconds", type: ApplicationCommandOptionTypes.Integer, required: true, minValue: 10 },
        {
          name: "action",
          description: "What happens when a raid is detected",
          type: ApplicationCommandOptionTypes.String,
          required: true,
          choices: [
            { name: "Alert staff only", value: "alert_only" },
            { name: "Force-enable verification", value: "lock_verification" },
            { name: "Kick new joins during lockdown", value: "kick_new_joins" },
          ],
        },
        { name: "alert_channel", description: "Channel to post raid alerts in", type: ApplicationCommandOptionTypes.Channel, required: false },
      ],
    },
    {
      name: "clear",
      description: "Manually end an active lockdown",
      type: ApplicationCommandOptionTypes.SubCommand,
    },
    {
      name: "status",
      description: "Check whether a lockdown is currently active",
      type: ApplicationCommandOptionTypes.SubCommand,
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const staffMember = interaction.member?.user ?? interaction.user;
  if (!guildId || !staffMember) return;

  const sub = interaction.data?.options?.[0];
  if (!sub) return;

  if (sub.name === "setup") {
    const opts = Object.fromEntries((sub.options ?? []).map((o) => [o.name, o.value]));
    await db
      .insert(schema.antiRaidConfigs)
      .values({
        guildId,
        enabled: true,
        joinThreshold: Number(opts.join_threshold),
        windowSeconds: Number(opts.window_seconds),
        action: String(opts.action) as "alert_only" | "lock_verification" | "kick_new_joins",
        alertChannelId: opts.alert_channel ? BigInt(String(opts.alert_channel)) : null,
      })
      .onConflictDoUpdate({
        target: schema.antiRaidConfigs.guildId,
        set: {
          enabled: true,
          joinThreshold: Number(opts.join_threshold),
          windowSeconds: Number(opts.window_seconds),
          action: String(opts.action) as "alert_only" | "lock_verification" | "kick_new_joins",
          alertChannelId: opts.alert_channel ? BigInt(String(opts.alert_channel)) : null,
          updatedAt: new Date(),
        },
      });

    return respond(
      bot,
      interaction,
      `Anti-raid enabled: alert if ${opts.join_threshold}+ joins within ${opts.window_seconds}s, action \`${opts.action}\`.`,
    );
  }

  if (sub.name === "clear") {
    const cleared = await clearLockdown(guildId, staffMember.id);
    return respond(bot, interaction, cleared ? "Lockdown cleared." : "No active lockdown to clear.");
  }

  if (sub.name === "status") {
    const active = await isLockdownActive(guildId);
    return respond(bot, interaction, active ? "🔒 A lockdown is currently active." : "No active lockdown.");
  }
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content, flags: EPHEMERAL },
  });
}
