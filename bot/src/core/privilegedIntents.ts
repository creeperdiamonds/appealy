// bot/src/core/privilegedIntents.ts
//
// Appealy asks Discord for two privileged intents: Server Members (welcomer,
// auto-roles, verification, auto-closing tickets and auto-denying applications
// when someone leaves) and Message Content (ticket transcripts, /poll's typed
// close time). Both are switches in the Developer Portal, off
// by default on every new application.
//
// With either switch off, Discord closes the gateway with 4014 "Disallowed
// intent(s)". Discordeno treats that as fatal and throws from inside the
// socket's close handler, where nothing catches it: the bot just never comes
// online, and the only trace is Discord's own three words. A self-hoster
// following the setup guide, or a customer pasting a dedicated bot's token, had
// no way to tell that one missed checkbox was the whole problem.
//
// So the application is asked first. GET /applications/@me returns its flags,
// and each intent has two: the full one, set once Discord approves it for a
// verified bot, and _LIMITED, set when the switch is on for a bot under 100
// servers. Either means Discord will accept the intent.

import { logger } from "../utils/logger.ts";

const GATEWAY_GUILD_MEMBERS = 1 << 14;
const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

export class MissingIntentsError extends Error {
  constructor(
    readonly applicationId: string,
    readonly missing: string[],
  ) {
    super(
      `Discord won't let this bot connect: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} switched off. ` +
        `Turn ${missing.length > 1 ? "them" : "it"} on at ${MissingIntentsError.settingsUrl(applicationId)} ` +
        `under "Privileged Gateway Intents" and save. A bot in 100 or more servers needs Discord's approval for ` +
        `these first, which is requested from the same page.`,
    );
    this.name = "MissingIntentsError";
  }

  /** The Bot page of this application in the Developer Portal, where the switches are. */
  static settingsUrl(applicationId: string): string {
    return `https://discord.com/developers/applications/${applicationId}/bot`;
  }
}

/**
 * Throws MissingIntentsError when Server Members or Message Content is switched
 * off for the application this token belongs to.
 *
 * Any other failure (a network blip, a token Discord rejects) is logged and let
 * through: the gateway connection that follows reports those better than a guess
 * here would, and a check that blocked startup on its own outage would be worse
 * than no check.
 */
export async function requirePrivilegedIntents(token: string): Promise<void> {
  let app: { id?: string; flags?: number };
  try {
    const res = await fetch("https://discord.com/api/v10/applications/@me", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) {
      logger.warn("Could not check privileged intents; connecting anyway", { status: res.status });
      return;
    }
    app = await res.json();
  } catch (err) {
    logger.warn("Could not check privileged intents; connecting anyway", { error: String(err) });
    return;
  }

  const flags = app.flags ?? 0;
  const missing: string[] = [];
  if (!(flags & (GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED))) missing.push("Server Members Intent");
  if (!(flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED))) missing.push("Message Content Intent");
  if (missing.length > 0) throw new MissingIntentsError(app.id ?? "your-application-id", missing);
}
