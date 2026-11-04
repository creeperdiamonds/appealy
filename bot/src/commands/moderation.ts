// bot/src/commands/moderation.ts
//
// /ban, /unban, /kick, /mute and /unmute. They replaced the "?ban" prefix
// commands when Discord asked for slash commands instead of reading messages
// (see services/modCommands.ts). services/moderation.ts does the checking and
// the work, shared with the "@Appealy ban" mention form.
//
// Each command is registered with the Discord permission it needs as its
// default, so members without it don't see it. Servers can change who sees
// it in Server Settings → Integrations; moderate() still checks the
// permission, the role order and the dashboard's role list, so changing that
// never lets anyone do more than Discord's own menus would.

import { ApplicationCommandOptionTypes, ApplicationCommandTypes } from "@discordeno/bot";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot, AppealyInteraction as Interaction } from "../core/client.ts";
import { moderate } from "../services/moderation.ts";
import { type ModAction, parseDuration } from "../services/modCommands.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

type Permission = "BAN_MEMBERS" | "KICK_MEMBERS" | "MODERATE_MEMBERS";

const user = (description: string, ja: string) => ({
  name: "user",
  description,
  descriptionLocalizations: { ja },
  type: ApplicationCommandOptionTypes.User,
  required: true,
});

const reason = {
  name: "reason",
  description: "Why. Shown in the server's audit log",
  descriptionLocalizations: { ja: "理由。サーバーの監査ログに表示されます" },
  type: ApplicationCommandOptionTypes.String,
  required: false,
  maxLength: 400,
};

const duration = (description: string, ja: string) => ({
  name: "duration",
  description,
  descriptionLocalizations: { ja },
  type: ApplicationCommandOptionTypes.String,
  required: false,
  maxLength: 20,
});

function command(
  action: ModAction,
  permission: Permission,
  description: string,
  ja: string,
  options: unknown[],
): { definition: CreateApplicationCommand; execute: (bot: AppealyBot, interaction: Interaction) => Promise<void> } {
  return {
    definition: {
      name: action,
      description,
      descriptionLocalizations: { ja },
      type: ApplicationCommandTypes.ChatInput,
      defaultMemberPermissions: [permission],
      dmPermission: false,
      options,
    } as CreateApplicationCommand,
    execute: (bot, interaction) => execute(bot, interaction, action),
  };
}

export const ban = command("ban", "BAN_MEMBERS", "Ban a member, for good or for a while", "メンバーを BAN します（無期限または期間付き）", [
  user("Who to ban. Works on someone who already left, too", "BAN するユーザー。サーバーを抜けた人にも使えます"),
  duration("How long, e.g. 7d or 12h. Leave empty for a permanent ban", "期間（例: 7d、12h）。空欄で無期限"),
  reason,
  {
    name: "appeal",
    description: "Send them the appeal button (default: yes)",
    descriptionLocalizations: { ja: "異議申し立てボタンを送ります（既定: はい）" },
    type: ApplicationCommandOptionTypes.Boolean,
    required: false,
  },
]);

export const unban = command("unban", "BAN_MEMBERS", "Lift a ban", "BAN を解除します", [
  user("Who to unban. Paste their user ID", "BAN を解除するユーザー。ユーザー ID を貼り付けます"),
  reason,
]);

export const kick = command("kick", "KICK_MEMBERS", "Remove a member from the server", "メンバーをサーバーから追い出します", [
  user("Who to kick", "追い出すユーザー"),
  reason,
]);

export const mute = command("mute", "MODERATE_MEMBERS", "Time a member out", "メンバーをタイムアウトします", [
  user("Who to time out", "タイムアウトするユーザー"),
  duration("How long, e.g. 10m, 2h or 1d. Up to 28d. Default 1h", "期間（例: 10m、2h、1d）。最大 28d。既定は 1h"),
  reason,
]);

export const unmute = command("unmute", "MODERATE_MEMBERS", "End a member's timeout", "タイムアウトを解除します", [
  user("Whose timeout to end", "タイムアウトを解除するユーザー"),
  reason,
]);

async function execute(bot: AppealyBot, interaction: Interaction, action: ModAction) {
  const guildId = interaction.guildId;
  const actor = interaction.member?.user ?? interaction.user;
  if (!guildId || !actor) return;

  // Public, the way a moderator's "?ban" reply was: the channel sees what was done.
  await defer(bot, interaction);

  const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
  let durationMs: number | null = null;
  if (typeof opts.duration === "string" && opts.duration.trim()) {
    durationMs = parseDuration(opts.duration.replace(/\s+/g, ""));
    if (durationMs === null) {
      return respond(bot, interaction, `\`${opts.duration}\` isn't a length I understand. Try \`10m\`, \`2h\`, \`7d\` or \`1h30m\`.`);
    }
  }

  const text = await moderate(bot, {
    guildId,
    actorId: actor.id,
    actorRoles: interaction.member?.roles ?? [],
    action,
    targetId: BigInt(String(opts.user)),
    durationMs,
    noAppeal: opts.appeal === false,
    reason: typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim().slice(0, 400) : null,
  });
  await respond(bot, interaction, text);
}

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  // Names people without pinging them, and never pings a role typed into a reason.
  await finish(bot, interaction, { content, allowedMentions: { parse: [] } });
}
