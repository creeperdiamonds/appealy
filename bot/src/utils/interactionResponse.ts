// bot/src/utils/interactionResponse.ts
//
// Discord gives a handler three seconds to make its FIRST response to an
// interaction. Anything slower and the token is dead: every later call
// against it fails with 10062, and the user is shown "This interaction
// failed" even when the work succeeded — which is the worst outcome
// available, because it invites them to click again.
//
// Deferring answers Discord immediately and extends the deadline to fifteen
// minutes. The pattern is: defer, work, finish.
//
// THE ONE THING THAT CANNOT BE DEFERRED
//
// A modal response must be the FIRST response — you cannot defer and then
// open a modal. Handlers that open modals (panelOpen, reviewDeny, and
// verify's captcha branch) therefore must not call defer() on those paths,
// and must keep their pre-checks cache-backed: a REST call before the modal
// blows the same three-second window with no fix available.
//
// The exemption is per-PATH, not per-file. verify.ts opens a modal only on
// the captcha branch; its button branch does four REST calls and two queries
// and defers like everything else. See deferGuard.test.ts's dedicated block
// for it.

import type { InteractionCallbackData } from "@discordeno/bot";
import type { AppealyBot, AppealyInteraction } from "../core/client.ts";

/** Discord's MessageFlags.Ephemeral. */
const EPHEMERAL = 64;

/** InteractionResponseTypes.DeferredChannelMessageWithSource. */
const DEFERRED = 5;

export interface InteractionEditPayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

/**
 * Answers Discord immediately so the work below has fifteen minutes.
 *
 * The ephemeral flag is set HERE and cannot be set later: once a deferred
 * response is public, editing it cannot make it private, and the channel is
 * left with a visible "thinking…" from a bot that meant to answer quietly.
 */
export async function defer(
  bot: AppealyBot,
  interaction: AppealyInteraction,
  opts: { ephemeral?: boolean } = {},
): Promise<void> {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: DEFERRED,
    data: opts.ephemeral ? { flags: EPHEMERAL } : {},
  });
}

/**
 * Delivers the result of a deferred interaction.
 *
 * No flags here — see defer(). Passing them would be silently ignored by
 * Discord, which is worse than being rejected.
 */
export async function finish(
  bot: AppealyBot,
  interaction: AppealyInteraction,
  payload: string | InteractionEditPayload,
): Promise<void> {
  const data = typeof payload === "string" ? { content: payload } : payload;
  await bot.helpers.editOriginalInteractionResponse(interaction.token, data as InteractionCallbackData);
}
