// bot/src/commands/antiRaid.ts
// /anti-raid setup|clear|status|undo

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { clearLockdown, isLockdownActive, undoLastRaid } from "../services/antiRaidService.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

const ADMINISTRATOR = 0x8n;

export const definition: CreateApplicationCommand = {
  name: "anti-raid",
  description: "Configure join-velocity raid detection",
  descriptionLocalizations: { ja: "参加速度による荒らし検知を設定します" },
  type: ApplicationCommandTypes.ChatInput,
  // Discordeno takes permission NAMES here, not a bitfield string. The
  // old form type-checked against nothing and would have registered the
  // command with a permission value Discord could not parse.
  defaultMemberPermissions: ["ADMINISTRATOR"],
  options: [
    {
      name: "setup",
      description: "Configure raid detection thresholds and response",
      descriptionLocalizations: { ja: "荒らし検知のしきい値と対応を設定します" },
      type: ApplicationCommandOptionTypes.SubCommand,
      options: [
        { name: "join_threshold", description: "Trigger if this many members join within the window", descriptionLocalizations: { ja: "この人数が時間枠内に参加したら作動します" }, type: ApplicationCommandOptionTypes.Integer, required: true, minValue: 3 },
        { name: "window_seconds", description: "Time window in seconds", descriptionLocalizations: { ja: "判定する時間枠（秒）" }, type: ApplicationCommandOptionTypes.Integer, required: true, minValue: 10 },
        {
          name: "action",
          description: "What happens when a raid is detected",
          descriptionLocalizations: { ja: "荒らしを検知したときの動作" },
          type: ApplicationCommandOptionTypes.String,
          required: true,
          choices: [
            { name: "Alert staff only", value: "alert_only" },
            { name: "Force-enable verification", value: "lock_verification" },
            { name: "Kick new joins during lockdown", value: "kick_new_joins" },
          ],
        },
        { name: "alert_channel", description: "Channel to post raid alerts in", descriptionLocalizations: { ja: "荒らし警告を送信するチャンネル" }, type: ApplicationCommandOptionTypes.Channel, required: false },
        { name: "new_account_days", description: "Only act on accounts younger than this many days. 0 means every account", descriptionLocalizations: { ja: "作成からこの日数未満のアカウントだけを対象にします。0 ですべてのアカウント" }, type: ApplicationCommandOptionTypes.Integer, required: false, minValue: 0, maxValue: 365 },
      ],
    },
    {
      name: "clear",
      description: "Manually end an active lockdown",
      descriptionLocalizations: { ja: "進行中のロックダウンを手動で解除します" },
      type: ApplicationCommandOptionTypes.SubCommand,
    },
    {
      name: "status",
      description: "Check whether a lockdown is currently active",
      descriptionLocalizations: { ja: "ロックダウンが有効かどうかを確認します" },
      type: ApplicationCommandOptionTypes.SubCommand,
    },
    {
      name: "undo",
      description: "False alarm: end the lockdown and reverse what it did",
      descriptionLocalizations: { ja: "誤検知のとき: ロックダウンを終了し、行った対応を元に戻します" },
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

  // Every branch below does at least one DB round trip (setup upserts a
  // config; clear/status go through antiRaidService's Redis-backed
  // lockdown state) — enough to blow Discord's three-second first-response
  // window. Deferring buys fifteen minutes.
  await defer(bot, interaction, { ephemeral: true });

  if (sub.name === "setup") {
    const opts = Object.fromEntries((sub.options ?? []).map((o) => [o.name, o.value]));
    // Left out of the command means keep what's saved, not reset it to 0.
    const newAccountDays = opts.new_account_days === undefined ? undefined : Number(opts.new_account_days);
    await db
      .insert(schema.antiRaidConfigs)
      .values({
        guildId,
        enabled: true,
        joinThreshold: Number(opts.join_threshold),
        windowSeconds: Number(opts.window_seconds),
        action: String(opts.action) as "alert_only" | "lock_verification" | "kick_new_joins",
        alertChannelId: opts.alert_channel ? BigInt(String(opts.alert_channel)) : null,
        newAccountDays: newAccountDays ?? 0,
      })
      .onConflictDoUpdate({
        target: schema.antiRaidConfigs.guildId,
        set: {
          enabled: true,
          joinThreshold: Number(opts.join_threshold),
          windowSeconds: Number(opts.window_seconds),
          action: String(opts.action) as "alert_only" | "lock_verification" | "kick_new_joins",
          alertChannelId: opts.alert_channel ? BigInt(String(opts.alert_channel)) : null,
          ...(newAccountDays === undefined ? {} : { newAccountDays }),
          updatedAt: new Date(),
        },
      });

    return respond(
      bot,
      interaction,
      `Anti-raid enabled: alert if ${opts.join_threshold}+ joins within ${opts.window_seconds}s, action \`${opts.action}\`.` +
        (newAccountDays ? ` Only accounts younger than ${newAccountDays} days count.` : ""),
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

  if (sub.name === "undo") {
    const result = await undoLastRaid(bot, guildId, staffMember.id);
    return respond(bot, interaction, describeUndo(result));
  }

  // Defensive fallback, not dead code. Discord validates subcommand names
  // against the registered `definition` above before routing here, so this
  // is unreachable today — but `definition` and this if-chain are two
  // separate objects kept in sync only by hand. Without this, a fourth
  // subcommand added to `definition` without a matching branch here would
  // defer above and then fall off the end of the function having never
  // finished, leaving the interaction on "thinking..." for the full fifteen
  // minutes. Before this file deferred, the same gap produced Discord's own
  // "This interaction failed" after three seconds — worse UX, but at least
  // truthful. See interactionCreate.ts's catch-all comment: "A hang is worse
  // than an error message — the error at least tells the truth."
  return respond(bot, interaction, "Unrecognised subcommand.");
}

/** Most IDs one message can carry as mentions and stay under Discord's limit. */
const MAX_KICKED_LISTED = 50;

function describeUndo(r: Awaited<ReturnType<typeof undoLastRaid>>): string {
  const lines: string[] = [];
  if (r.lockdownCleared) lines.push("Lockdown ended.");
  if (r.verificationTurnedOff) lines.push("Verification is back off.");
  if (r.unrestricted > 0) lines.push(`Removed the unverified role from ${r.unrestricted} member(s).`);
  if (r.failed > 0) lines.push(`Couldn't remove it from ${r.failed}, usually because they left.`);
  if (r.kickedUserIds.length > 0) {
    const shown = r.kickedUserIds.slice(0, MAX_KICKED_LISTED).map((id) => `<@${id}>`).join(" ");
    const more = r.kickedUserIds.length - MAX_KICKED_LISTED;
    lines.push(
      `${r.kickedUserIds.length} account(s) were kicked. That can't be reversed, but they can rejoin with an invite: ` +
        shown + (more > 0 ? ` and ${more} more` : ""),
    );
  }
  return lines.length > 0 ? lines.join("\n") : "Nothing to undo.";
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change.
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
