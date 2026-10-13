// bot/src/services/welcomeMessage.ts
//
// The one message Appealy posts when it's added to a server: what it does and
// how to start, with a button to the dashboard.
//
// Before this the bot joined in silence, and most servers that removed it did
// so within the hour without ever making a form (2026-10-14: 37 of 56 left
// inside an hour, 41 had made nothing). The steps were only in /help, which a
// new admin has no reason to type.
//
// Pure, so it can be tested without Discord (__tests__/welcomeMessage.test.ts).
// services/welcome.ts decides when and where to send it.

import { channelPermissions, P, type Overwrite, type SetupGuild } from "./setupRules.ts";

export interface WelcomeOptions {
  /** The server's language is Japanese. */
  ja: boolean;
  brand: string;
  /** Opens the dashboard on this server. */
  dashboardUrl: string;
  /** Empty leaves the support button out. */
  supportUrl: string;
  /** Command name → id, for mentions people can click. */
  ids: ReadonlyMap<string, string>;
  /**
   * The hosted platform asks every server to pick a channel for Appealy's
   * updates (api/src/routes/updates.ts), so it's the first step there.
   * Self-hosted deployments are never asked.
   */
  updatesStep: boolean;
}

/** The accent of the site and the dashboard, as in /help. */
const COLOR = 0x5aa9ff;

/** How recent a join must be to count as the bot being added, not a reconnect. */
export const FRESH_JOIN_MS = 2 * 60_000;

const TEXT = {
  en: {
    title: (brand: string) => `Thanks for adding ${brand}!`,
    intro: (brand: string) =>
      `**${brand}** runs your server's applications and appeals. Members fill in forms from a ` +
      "panel or in their DMs, and your staff review them in one place. Tickets, verification, " +
      "AutoMod, giveaways and polls come with it.",
    start: "Getting started",
    updates: (brand: string) =>
      `Open the dashboard and pick a channel for ${brand}'s updates. It's required, and it's how ` +
      "you'll hear about new features and fixes.",
    form: "Create a form on the dashboard.",
    post: (panel: string, apply: string) => `Post it with ${panel}, or let members use ${apply}.`,
    review: "Answers arrive in the channel you choose, with Accept and Deny buttons.",
    help: (help: string) => `${help} lists every command.`,
    dashboard: "Open dashboard",
    support: "Support server",
  },
  ja: {
    title: (brand: string) => `${brand} を追加していただきありがとうございます！`,
    intro: (brand: string) =>
      `**${brand}** は、サーバーの応募と異議申し立てを受け付けるボットです。メンバーはパネルや ` +
      "DM からフォームに回答し、スタッフが一か所で審査します。チケット、認証、AutoMod、" +
      "ギブアウェイ、投票も使えます。",
    start: "はじめかた",
    updates: (brand: string) =>
      `ダッシュボードを開き、${brand} のアップデートを受け取るチャンネルを選びます。必須の設定で、` +
      "新機能や修正のお知らせが届きます。",
    form: "ダッシュボードでフォームを作成します。",
    post: (panel: string, apply: string) => `${panel} で公開するか、メンバーに ${apply} を使ってもらいます。`,
    review: "回答は指定したチャンネルに届き、「Accept」「Deny」ボタンで審査できます。",
    help: (help: string) => `${help} ですべてのコマンドを確認できます。`,
    dashboard: "ダッシュボードを開く",
    support: "サポートサーバー",
  },
};

export function welcomeMessage(o: WelcomeOptions) {
  const t = o.ja ? TEXT.ja : TEXT.en;
  const mention = (name: string, sub?: string) => {
    const path = sub ? `${name} ${sub}` : name;
    const id = o.ids.get(name);
    return id ? `</${path}:${id}>` : `\`/${path}\``;
  };

  const steps = [
    ...(o.updatesStep ? [t.updates(o.brand)] : []),
    t.form,
    t.post(mention("panel", "create"), mention("apply")),
    t.review,
  ];

  const buttons = [
    { type: 2, style: 5, label: t.dashboard, url: o.dashboardUrl },
    ...(o.supportUrl ? [{ type: 2, style: 5, label: t.support, url: o.supportUrl }] : []),
  ];

  return {
    embeds: [
      {
        title: t.title(o.brand),
        description:
          `${t.intro(o.brand)}\n\n**${t.start}**\n` +
          steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
          `\n\n${t.help(mention("help"))}`,
        color: COLOR,
      },
    ],
    components: [{ type: 1, components: buttons }],
  };
}

/**
 * Whether a guildCreate is the bot being added. Discord also sends one for
 * every server on each reconnect, with the original join time, so only a join
 * from the last couple of minutes counts.
 */
export function isFreshJoin(joinedAt: number | undefined, now = Date.now()): boolean {
  return joinedAt !== undefined && now - joinedAt < FRESH_JOIN_MS;
}

export interface WelcomeChannel {
  id: string;
  /** 0 is a text channel. */
  type: number;
  position: number;
  overwrites: Overwrite[];
}

/**
 * Where to post: the server's system channel, where Discord announces new
 * members and bots, if Appealy may post there; otherwise the highest text
 * channel it may post in. Null when there is none.
 */
export function welcomeChannel(g: SetupGuild, channels: WelcomeChannel[], systemChannelId: string | null): string | null {
  const need = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS;
  const canPost = (c: WelcomeChannel) => c.type === 0 && (channelPermissions(g, c.overwrites) & need) === need;
  const system = channels.find((c) => c.id === systemChannelId);
  if (system && canPost(system)) return system.id;
  const first = channels.filter(canPost).sort((a, b) => a.position - b.position)[0];
  return first?.id ?? null;
}
