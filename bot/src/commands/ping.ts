// bot/src/commands/ping.ts
// /ping — how long each part of a command takes. Small, but the kind of thing
// every admin expects to exist on day one to sanity-check the bot is alive and
// responsive before troubleshooting anything else, and the first question
// when something feels slow: is it Appealy, or Discord? The wording lives in
// services/pingReport.ts.

import { ApplicationCommandTypes } from "@discordeno/bot";
import { sql } from "drizzle-orm";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db } from "../db/client.ts";
import { pingReport, snowflakeTime } from "../services/pingReport.ts";

const EPHEMERAL = 64;

/** Past this, the database counts as unavailable rather than slow. */
const DATABASE_TIMEOUT_MS = 3_000;

export const definition: CreateApplicationCommand = {
  name: "ping",
  description: "Check the bot's latency",
  descriptionLocalizations: { ja: "ボットの応答速度を確認します" },
  type: ApplicationCommandTypes.ChatInput,
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  // The command's id says when Discord created it: the moment it was sent.
  const receivedAt = Date.now();
  const ja = interaction.locale?.startsWith("ja") ?? false;

  // A ping has nothing to work out, so Appealy's own share is only the
  // moments before the reply leaves. Measured anyway rather than claimed.
  const sentAt = Date.now();
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { content: ja ? "計測中…" : "Pinging…", flags: EPHEMERAL },
  });
  const repliedAt = Date.now();

  // After the reply, so none of these can hold up Discord's three-second window.
  const network = await timeDiscordNetwork(bot);
  const database = await timeDatabase();
  await bot.helpers.editOriginalInteractionResponse(interaction.token, {
    content: pingReport(
      {
        toBot: receivedAt - snowflakeTime(interaction.id),
        own: sentAt - receivedAt,
        toDiscord: repliedAt - sentAt,
        network,
        database,
        heartbeat: heartbeatFor(bot, interaction.guildId),
      },
      ja,
    ),
  });
}

/**
 * The travel part of "Appealy → Discord": a request that asks Discord for
 * almost nothing, its gateway address, which needs no login and no work.
 * Sent to the same address as every reply, straight after one, so it rides
 * the same warm connection. Whatever the reply took beyond this was
 * Discord's side.
 */
async function timeDiscordNetwork(bot: AppealyBot): Promise<number | null> {
  const started = Date.now();
  try {
    const res = await fetch(`${bot.rest.baseUrl}/v${bot.rest.version}/gateway`, {
      signal: AbortSignal.timeout(3_000),
    });
    const elapsed = Date.now() - started;
    await res.body?.cancel();
    return res.ok ? elapsed : null;
  } catch {
    return null;
  }
}

/** A trivial query's round trip, or null if it failed or took too long. */
async function timeDatabase(): Promise<number | null> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DATABASE_TIMEOUT_MS);
      }),
    ]);
    return Date.now() - started;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The heartbeat round trip of the connection this server's events arrive on.
 * Discord assigns a server to a connection (shard) by (server id >> 22) %
 * shard count; a DM arrives on the first. Read defensively, like the health
 * endpoint's (core/controlServer.ts): Discordeno's gateway internals move
 * between releases, and a ping that throws helps nobody.
 */
function heartbeatFor(bot: AppealyBot, guildId: bigint | undefined): number | null {
  try {
    const gateway = (bot as unknown as {
      gateway?: { totalShards?: number; shards?: Map<number, { heart?: { rtt?: number } }> };
    }).gateway;
    const total = Math.max(gateway?.totalShards ?? 1, 1);
    const shardId = guildId ? Number((guildId >> 22n) % BigInt(total)) : 0;
    return gateway?.shards?.get(shardId)?.heart?.rtt ?? null;
  } catch {
    return null;
  }
}
