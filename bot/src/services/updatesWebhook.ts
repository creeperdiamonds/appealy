// bot/src/services/updatesWebhook.ts
//
// How Appealy's updates look in a server that follows them. Discord posts
// followed messages through a webhook it creates in that server, named after
// the source ("creeper_diamonds's suppport server #changelog-_appealy") with
// the source server's icon. Appealy has Manage Webhooks there (it needed it
// to set the follow up), so it renames the webhook to "Appealy Updates" and
// gives it the Appealy door, and every update arrives under that.
//
// Called when a follow is made and each time the dashboard checks one, so
// follows made before this existed are brought in line on the next visit.
// Only edits when the name is wrong: avatar changes are rate limited.

import type { AppealyBot } from "../core/client.ts";
import { logger } from "../utils/logger.ts";

export const UPDATES_NAME = "Appealy Updates";

let avatar: string | null = null;
async function avatarDataUri(): Promise<string> {
  if (!avatar) {
    const bytes = await Deno.readFile(new URL("../../assets/updates-avatar.png", import.meta.url));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    avatar = `data:image/png;base64,${btoa(binary)}`;
  }
  return avatar;
}

/**
 * Gives the follow's webhook Appealy's name and icon, unless it has them.
 * Raw REST, not the helpers: the bot's desiredProperties keep no webhook
 * fields, so the transformed webhook wouldn't have a name to compare.
 * Never throws: a follow that works but looks generic is still a follow.
 */
export async function brandUpdatesWebhook(bot: AppealyBot, webhookId: bigint, current?: { name?: string | null }) {
  try {
    const hook = current ?? ((await bot.rest.getWebhook(webhookId)) as { name?: string | null });
    if (hook.name === UPDATES_NAME) return;
    await bot.rest.editWebhook(webhookId, { name: UPDATES_NAME, avatar: await avatarDataUri() } as never);
  } catch (err) {
    logger.warn("Couldn't brand the updates webhook", { webhookId: webhookId.toString(), error: String(err) });
  }
}
