// bot/src/events/messageCreate.ts
//
// This is the highest-frequency handler in the bot by a wide margin. Every
// other event fires per join, per interaction, or per scheduled tick;
// this one fires per message, across every channel of every guild.
// Whatever it does, it does millions of times a day.
//
// Two responsibilities:
//   1. DM application replies — route a DM into dmApplicationService if the
//      author has an in-progress direct_message application.
//   2. Sticky message bump — count guild messages and repost the channel's
//      sticky once it's been buried.
//
// THE COST MODEL
// --------------
// Original: every guild message did `SELECT * FROM sticky_messages WHERE
// channel_id = $1` and, on a hit, an UPDATE. Every DM did a lookup into
// dm_application_progress. Neither was cached. With a 10-connection
// Postgres pool, this saturates well before the gateway does, and the
// symptom is misleading — the bot appears to "randomly disconnect" when
// what's actually happening is that event processing has backed up behind
// the connection pool long enough to miss gateway heartbeats.
//
// Now: a message in a channel with no sticky costs one Map lookup and one
// Array.includes on a short array. No syscall, no await that touches the
// network. That's the case for ~99% of messages, and it's the only number
// that matters here.
//
// The DM path is left doing its own lookup deliberately. DMs to a bot are
// rare relative to guild messages, and an in-progress application is
// stateful mid-conversation data where a stale cache would drop a user's
// answer. Optimizing a low-volume path at the cost of correctness on it
// would be the wrong trade.

import type { AppealyBot } from "../core/client.ts";
import { handleDmApplicationReply } from "../services/dmApplicationService.ts";
import { bumpStickyMessageCounter } from "../services/stickyMessageService.ts";
import { getGuildConfig, stickyChannelHint } from "../core/guildConfigCache.ts";
import { passesBanGateForMessage } from "../core/banGate.ts";
import { logger } from "../utils/logger.ts";

// Guilds whose config we've asked for but haven't received yet. Without
// this, a cold guild receiving a burst of messages fires a cache-warm for
// every one of them before the first resolves.
const warming = new Set<string>();

export function onMessageCreate(bot: AppealyBot) {
  return async (message: {
    id: bigint;
    channelId: bigint;
    guildId?: bigint;
    author?: { id: bigint; toggles?: { bot?: boolean } };
    content?: string;
  }) => {
    // Cheapest possible check, before any database read. No reply on this
    // path ever — a banned guild is by definition one we don't want to be
    // sending messages into, and it already got its one ephemeral notice
    // from the interaction path.
    if (!passesBanGateForMessage(message.authorId ?? message.author?.id, message.guildId)) return;

    // Bot and webhook messages are ignored entirely. Checked first because
    // it's free and because letting them through would make the sticky
    // repost trigger its own recount.
    if (message.author?.toggles?.bot) return;

    if (!message.guildId) {
      if (!message.author) return;
      try {
        await handleDmApplicationReply(bot, message.author.id, message.content ?? "");
      } catch (err) {
        logger.error("Error handling potential DM application reply", {
          error: String(err),
          userId: message.author.id.toString(),
        });
      }
      return;
    }

    // ---- Hot path starts here ----
    const hint = stickyChannelHint(message.guildId, message.channelId);

    if (hint === false) return; // Cached, and this channel has no sticky. Done — zero I/O.

    if (hint === null) {
      // Cold cache for this guild. Warm it in the background and let this
      // one message through unhandled rather than blocking the event loop
      // on a database read. Missing a single increment on the first message
      // after a restart shifts a repost by one message; blocking here would
      // shift the whole gateway.
      const key = message.guildId.toString();
      if (!warming.has(key)) {
        warming.add(key);
        getGuildConfig(message.guildId)
          .catch((err) => logger.warn("Failed to warm guild config cache", {
            guildId: key,
            error: String(err),
          }))
          .finally(() => warming.delete(key));
      }
      return;
    }

    try {
      await bumpStickyMessageCounter(bot, message.channelId);
    } catch (err) {
      logger.error("Error bumping sticky message counter", {
        channelId: message.channelId.toString(),
        error: String(err),
      });
    }
  };
}
