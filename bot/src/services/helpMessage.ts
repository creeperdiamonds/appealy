// bot/src/services/helpMessage.ts
//
// What /help shows: what the bot does, how to start, and every command.
//
// Built from the commands' own definitions rather than a list kept by hand, so
// a command appears here the moment it's registered, with the description
// Discord shows in the command picker, Japanese included.
//
// Top.gg asks for "a clear and obvious point of entry (e.g. a working help
// command)" before it lists a bot; this is it. Free of env and network so it
// can be tested: commands/help.ts supplies the links and the command ids.

import type { CreateApplicationCommand } from "@discordeno/bot";

export interface HelpOptions {
  /** Answer in Japanese: the person asking has Discord set to Japanese. */
  ja: boolean;
  brand: string;
  dashboardUrl: string;
  docsUrl: string;
  /** Empty leaves the support button out. */
  supportUrl: string;
  /** Command name → id, for mentions people can click. A name missing here is written as plain /name. */
  ids: ReadonlyMap<string, string>;
  /** This server's prefix for the text moderation commands. Default "?". */
  prefix?: string;
  /** False when the server turned the text commands off: their section is left out. */
  textCommands?: boolean;
}

/** Moving a server's setup and data. Grouped apart from the everyday admin commands. */
const DATA = new Set(["export", "import-appealy", "import-appy"]);

/** The order /help lists commands in. Anything not named here follows, in registration order. */
const ORDER = [
  "apply", "application", "forms", "dashboard", "poll", "help", "botstats", "ping",
  "panel", "ticket-panel", "role-menu", "verify-setup", "giveaway", "anti-raid",
  "reset-cooldown", "export_applications",
  "export", "import-appealy", "import-appy",
];

/**
 * Discord's option type for a subcommand. The number rather than Discordeno's
 * enum: importing the library for real loads its gateway code, which reads the
 * environment, and this file has to load in tests that have none.
 */
const SUBCOMMAND = 1;

/** Discord's limit on one embed field's value. */
const FIELD_MAX = 1024;

/** The accent of the site and the dashboard. */
const COLOR = 0x5aa9ff;

type Described = { description: string; descriptionLocalizations?: Partial<Record<string, string>> };

const TEXT = {
  en: {
    title: (brand: string) => `${brand} help`,
    intro: (brand: string, panel: string, apply: string) =>
      `**${brand}** runs your server's applications and appeals. Members fill in forms from a ` +
      "panel or in their DMs, and your staff review them in one place. Tickets, verification, " +
      "AutoMod, giveaways and polls come with it.\n\n" +
      "**Getting started**\n" +
      "1. Open the dashboard with the button below and create a form.\n" +
      `2. Post it with ${panel}, or let members use ${apply}.\n` +
      "3. Answers arrive in the channel you choose, with Accept and Deny buttons.\n\n" +
      "Appeals, AutoMod and welcome messages are set up in the dashboard.",
    everyone: "Commands for everyone",
    admins: "Commands for server admins",
    data: "Moving your data",
    moderation: "Moderation (type these in chat)",
    moderationLines: [
      "`?ban [noappeal] @user [7d…] [reason]` · `?unban <id> [reason]`",
      "`?kick @user [reason]`",
      "`?mute @user [10m, 2h, 1d…] [reason]` · `?unmute @user`",
      "Also works as `@Appealy ban @user …`. A length makes a ban temporary; `noappeal` skips the appeal button. Servers can change the prefix, limit these to roles or turn them off on the dashboard.",
    ],
    dashboard: "Open the dashboard",
    docs: "Documentation",
    support: "Support server",
  },
  ja: {
    title: (brand: string) => `${brand} ヘルプ`,
    intro: (brand: string, panel: string, apply: string) =>
      `**${brand}** は、サーバーの応募と異議申し立てを受け付けるボットです。メンバーはパネルや ` +
      "DM からフォームに回答し、スタッフが一か所で審査します。チケット、認証、AutoMod、" +
      "ギブアウェイ、投票も使えます。\n\n" +
      "**はじめかた**\n" +
      "1. 下のボタンからダッシュボードを開き、フォームを作成します。\n" +
      `2. ${panel} で公開するか、メンバーに ${apply} を使ってもらいます。\n` +
      "3. 回答は指定したチャンネルに届き、「Accept」「Deny」ボタンで審査できます。\n\n" +
      "異議申し立て、AutoMod、ウェルカムメッセージはダッシュボードで設定します。",
    everyone: "全員が使えるコマンド",
    admins: "サーバー管理者向けコマンド",
    data: "データの移行",
    moderation: "モデレーション（チャットに入力）",
    moderationLines: [
      "`?ban [noappeal] @ユーザー [7d…] [理由]` · `?unban <ID> [理由]`",
      "`?kick @ユーザー [理由]`",
      "`?mute @ユーザー [10m, 2h, 1d…] [理由]` · `?unmute @ユーザー`",
      "`@Appealy ban @ユーザー …` の形でも使えます。長さを付けると期限付きの BAN になり、`noappeal` を付けると申し立てボタンは送られません。プレフィックスの変更、ロールの制限、無効化はダッシュボードでできます。",
    ],
    dashboard: "ダッシュボードを開く",
    docs: "ドキュメント",
    support: "サポートサーバー",
  },
};

export function helpMessage(definitions: readonly CreateApplicationCommand[], o: HelpOptions) {
  const t = o.ja ? TEXT.ja : TEXT.en;
  const describe = (d: Described) => (o.ja && d.descriptionLocalizations?.ja) || d.description;

  // `/panel create` is mentioned by the top-level command's id: Discord's
  // mention syntax for a subcommand is </panel create:ID>.
  const mention = (name: string, sub?: string) => {
    const path = sub ? `${name} ${sub}` : name;
    const id = o.ids.get(name);
    return id ? `</${path}:${id}>` : `\`/${path}\``;
  };

  const lines = (d: CreateApplicationCommand): string[] => {
    // Context-menu commands (right-click ones) have no options; none exist yet,
    // but the type allows them.
    const options = "options" in d ? d.options ?? [] : [];
    const subs = options.filter((opt) => opt.type === SUBCOMMAND);
    if (subs.length === 0) return [`${mention(d.name)} — ${describe(d as Described)}`];
    return subs.map((s) => `${mention(d.name, s.name)} — ${describe(s as Described)}`);
  };

  const rank = (name: string) => {
    const i = ORDER.indexOf(name);
    return i === -1 ? ORDER.length : i;
  };
  const sorted = [...definitions].sort((a, b) => rank(a.name) - rank(b.name));
  const forAdmins = (d: CreateApplicationCommand) => (d.defaultMemberPermissions?.length ?? 0) > 0;

  const groups: [string, CreateApplicationCommand[]][] = [
    [t.everyone, sorted.filter((d) => !DATA.has(d.name) && !forAdmins(d))],
    [t.admins, sorted.filter((d) => !DATA.has(d.name) && forAdmins(d))],
    [t.data, sorted.filter((d) => DATA.has(d.name))],
  ];

  const buttons = [
    { type: 2, style: 5, label: t.dashboard, url: o.dashboardUrl },
    { type: 2, style: 5, label: t.docs, url: o.docsUrl },
    ...(o.supportUrl ? [{ type: 2, style: 5, label: t.support, url: o.supportUrl }] : []),
  ];

  return {
    embeds: [
      {
        title: t.title(o.brand),
        description: t.intro(o.brand, mention("panel", "create"), mention("apply")),
        color: COLOR,
        fields: [
          ...groups.flatMap(([name, defs]) => fields(name, defs.flatMap(lines))),
          // Text commands aren't application commands, so they aren't in
          // `definitions`; written out here (services/modCommands.ts), with
          // the server's own prefix.
          ...(o.textCommands === false
            ? []
            : fields(t.moderation, t.moderationLines.map((l) => l.replaceAll("`?", "`" + (o.prefix ?? "?"))))),
        ],
      },
    ],
    components: [{ type: 1, components: buttons }],
  };
}

/**
 * A group's lines as embed fields, split where a field would pass Discord's
 * 1024 characters. The fields after the first are named with a zero-width
 * space, which Discord requires to be non-empty but which shows as nothing,
 * so the group still reads as one list.
 */
function fields(name: string, lines: string[]): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  let chunk: string[] = [];
  const flush = () => {
    if (chunk.length === 0) return;
    out.push({ name: out.length === 0 ? name : "​", value: chunk.join("\n") });
    chunk = [];
  };
  for (const line of lines) {
    if (chunk.length > 0 && [...chunk, line].join("\n").length > FIELD_MAX) flush();
    chunk.push(line);
  }
  flush();
  return out;
}
