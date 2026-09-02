// bot/src/interactions/selects/timezonePick.ts
//
// The answer to "which one did you mean?".
//
// When someone types a timezone that names more than one place — IST is
// India, Ireland and Israel; "united states" spans five offsets — the parser
// refuses rather than guessing, and hands back the options. This is where the
// person picks one.
//
// It does not reply. The chosen value goes to whatever asked the question,
// through the same waiter that a typed reply would have gone through
// (services/pendingPrompts.ts), so the caller has one thing to await and one
// code path to reason about whether the answer was typed or clicked. The
// value is always something resolveZone can read back — an IANA id — so the
// answer re-enters the parser by the front door.
//
// This handler must NOT defer in the usual sense: it acknowledges with a
// deferred message UPDATE, which promises nothing and shows nothing, because
// the message belongs to the code that is waiting.

import type { AppealyBot, AppealyInteraction as Interaction } from "../../core/client.ts";
import { deliverReply } from "../../services/pendingPrompts.ts";
import { acknowledgeComponent } from "../../utils/interactionResponse.ts";

export async function handleTimezonePick(
  bot: AppealyBot,
  interaction: Interaction,
  askedUserId: string,
) {
  const chosen = interaction.data?.values?.[0];
  const clicker = interaction.member?.user ?? interaction.user;
  const channelId = interaction.channelId;
  if (!chosen || !clicker || !channelId) return;

  // Always acknowledge, including for someone who is not the asker. Their
  // click is a no-op, but leaving it unacknowledged shows them a failure.
  await acknowledgeComponent(bot, interaction);

  // The waiter is keyed by (channel, user), so a stranger's pick would find
  // no waiter and deliver nothing anyway. Checked explicitly regardless: the
  // menu sits in a public channel, and relying on a lookup missing is a
  // weaker guarantee than not looking.
  if (clicker.id.toString() !== askedUserId) return;

  deliverReply(channelId, clicker.id, chosen);
}
