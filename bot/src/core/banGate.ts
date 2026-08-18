// bot/src/core/banGate.ts
//
// The gate that actually enforces a ban.
//
// A ban checked only by the dashboard is decorative. Nobody abuses this
// product through the settings UI — they abuse it through slash commands,
// panel buttons, and form modals, none of which touch api/. So the real
// enforcement point is here, before interactionCreate routes anything.
//
// Two failure modes this is shaped around
// ---------------------------------------
// 1. Replying to every interaction from a banned guild turns the ban into an
//    outbound spam campaign against that server, and it is our bot doing the
//    spamming. So: one ephemeral message per subject per hour, then silence.
//
// 2. Silently dropping everything makes a ban indistinguishable from an
//    outage. The server posts "the bot is broken" in a support channel and a
//    human has to work out that it was banned three weeks ago. So: not zero
//    messages either. One clear one, with a link, then quiet.
//
// The cooldown key lives in Redis rather than in memory because otherwise
// every bot replica would send its own copy of the "once per hour" message.

import { withRedis } from "./redis.ts";
import type { AppealyInteraction as Interaction } from "./client.ts";
import { isBanned } from "./banCache.ts";
import { logger } from "../utils/logger.ts";
import type { AppealyBot } from "./client.ts";

import { env } from "./env.ts";

const NOTIFY_COOLDOWN_SECONDS = 3600;

function banMessage(subject: "user" | "guild", reasonPublic: string): string {
  const where = subject === "guild" ? "This server can't use Appealy." : "Your account can't use Appealy.";
  const who = subject === "guild" ? "Anyone with Manage Server can appeal" : "You can appeal";
  return `${where}\n\n**Reason:** ${reasonPublic}\n\n${who} at ${env.DASHBOARD_URL}`;
}

/**
 * Returns true if the interaction should proceed.
 *
 * Call this as the first statement inside onInteractionCreate, before the
 * type switch. Anything that returns false is dropped entirely — no defer,
 * no handler, no database read.
 */
export async function passesBanGate(
  bot: AppealyBot,
  interaction: Interaction,
): Promise<boolean> {
  const userId = interaction.user?.id ?? interaction.member?.id;
  if (!userId) return true;

  const ban = isBanned(userId, interaction.guildId);
  if (!ban) return true;

  // Reply at most once per subject per hour, across all replicas. SET NX EX
  // is the whole lock — if we lose the race, another replica already told them.
  const first = await withRedis(
    (r) =>
      r.set(`bans:notified:${ban.subject}:${ban.subjectId}`, "1", {
        ex: NOTIFY_COOLDOWN_SECONDS,
        mode: "NX",
      }),
    null,
  );

  if (first) {
    await bot.helpers
      .sendInteractionResponse(interaction.id, interaction.token, {
        type: 4,
        data: { flags: 64, content: banMessage(ban.subject, ban.reasonPublic) },
      })
      .catch((err) => logger.warn("Failed to send ban notice", { err, banId: ban.id }));
  }

  return false;
}

/**
 * Message-path variant. Cheaper: no reply at all, ever.
 *
 * messageCreate runs for every message in every channel, and a banned guild
 * is by definition one we do not want to be sending messages into. Sticky
 * messages, autoresponses and the rest simply stop. The guild already got
 * its one ephemeral notice from the interaction path.
 */
export function passesBanGateForMessage(userId: bigint, guildId?: bigint): boolean {
  return isBanned(userId, guildId) === null;
}
