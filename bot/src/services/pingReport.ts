// bot/src/services/pingReport.ts
//
// What /ping shows: where the time went, split between Discord and Appealy.
//
// One "round-trip" number read as the bot's speed, when most of it was Discord
// accepting the reply. Split up, it answers the question people ask /ping for:
// is it Appealy that's slow, or Discord?
//
// Free of env and network so it can be tested; commands/ping.ts measures.

/** Discord's epoch. A snowflake id counts milliseconds from 2015-01-01 UTC. */
const DISCORD_EPOCH = 1_420_070_400_000;

/** When Discord created something, read from its id. */
export function snowflakeTime(id: bigint): number {
  return Number(id >> 22n) + DISCORD_EPOCH;
}

export interface PingTimes {
  /** Discord → Appealy: from Discord creating the command to Appealy starting on it. */
  toBot: number;
  /** Appealy working out the reply, with no Discord involved. */
  own: number;
  /** Appealy → Discord: Discord accepting the reply. */
  toDiscord: number;
  /**
   * A request that makes Discord do no work, on the same connection: the
   * travel part of toDiscord. Null when it failed.
   */
  network: number | null;
  /** A trivial database query, or null when it failed. */
  database: number | null;
  /** The live connection's heartbeat round trip, or null before the first one. */
  heartbeat: number | null;
}

const TEXT = {
  en: {
    title: "**Pong!** Here's where the time went:",
    toBot: "Discord → Appealy",
    toBotNote: "your command reaching the bot",
    own: "Appealy on its own",
    ownNote: "working out the reply",
    toDiscord: "Appealy → Discord",
    toDiscordNote: "Discord accepting the reply",
    split: (network: number, discord: number) =>
      `  ↳ network: **${network} ms** · Discord's side: **about ${discord} ms**`,
    total: "Total",
    database: "Database",
    heartbeat: "Connection to Discord",
    unavailable: "unavailable",
    notYet: "not measured yet",
  },
  ja: {
    title: "**Pong!** かかった時間の内訳:",
    toBot: "Discord → Appealy",
    toBotNote: "コマンドがボットに届くまで",
    own: "Appealy の処理",
    ownNote: "返信を用意するまで。Discord は関係なし",
    toDiscord: "Appealy → Discord",
    toDiscordNote: "Discord が返信を受け付けるまで",
    split: (network: number, discord: number) =>
      `  ↳ 通信: **${network} ms** · Discord 側: **約 ${discord} ms**`,
    total: "合計",
    database: "データベース",
    heartbeat: "Discord との接続",
    unavailable: "利用できません",
    notYet: "まだ計測されていません",
  },
};

/**
 * Whole milliseconds, never negative. Discord → Appealy compares Discord's
 * clock with this server's, and the two can disagree by a few milliseconds in
 * either direction.
 */
function ms(value: number): number {
  return Math.max(0, Math.round(value));
}

export function pingReport(t: PingTimes, ja: boolean): string {
  const x = ja ? TEXT.ja : TEXT.en;
  const line = (label: string, value: number, note: string) =>
    ja ? `${label}: **${ms(value)} ms**（${note}）` : `${label}: **${ms(value)} ms**, ${note}`;
  const total = ms(t.toBot) + ms(t.own) + ms(t.toDiscord);
  const database = t.database === null ? x.unavailable : `**${ms(t.database)} ms**`;
  const heartbeat = t.heartbeat === null ? x.notYet : `**${ms(t.heartbeat)} ms**`;
  // Discord's side is what's left once the travel is taken out: its own
  // processing plus its internal hops, which a request from outside can't
  // separate. Floored at zero, because both are measured and either can jitter.
  const split = t.network === null
    ? []
    : [x.split(ms(t.network), Math.max(0, ms(t.toDiscord) - ms(t.network)))];
  return [
    x.title,
    line(x.toBot, t.toBot, x.toBotNote),
    line(x.own, t.own, x.ownNote),
    line(x.toDiscord, t.toDiscord, x.toDiscordNote),
    ...split,
    `${x.total}: **${total} ms**`,
    "",
    `${x.database}: ${database} · ${x.heartbeat}: ${heartbeat}`,
  ].join("\n");
}
