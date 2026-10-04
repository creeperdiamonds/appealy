// bot/src/commands/help.ts
// /help — what Appealy does, how to start, and every command, with buttons to
// the dashboard, the docs and the support server. The message itself is built
// in services/helpMessage.ts.

import { ApplicationCommandTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { deployment, env } from "../core/env.ts";
import { defer, finish } from "../utils/interactionResponse.ts";
import { helpMessage } from "../services/helpMessage.ts";
import { getGuildConfig } from "../core/guildConfigCache.ts";
import { logger } from "../utils/logger.ts";

/**
 * The hosted bot's support server, the one the website links to. Production
 * doesn't set SUPPORT_URL, so without this /help would have no way to ask for
 * help. A self-hosted deployment sets SUPPORT_URL to its own, or shows none.
 */
const PLATFORM_SUPPORT_URL = "https://discord.gg/UwBMug9JyX";
const DOCS_URL = "https://docs.appealy.app";

export const definition: CreateApplicationCommand = {
  name: "help",
  description: "What Appealy does, how to set it up, and every command",
  descriptionLocalizations: { ja: "Appealy の機能、設定のしかた、すべてのコマンド" },
  type: ApplicationCommandTypes.ChatInput,
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  // Private to whoever asked: a public reply would put the whole command list
  // in the channel every time someone looks.
  await defer(bot, interaction, { ephemeral: true });

  // Imported here rather than at the top because index.ts imports this file.
  // By the time anyone runs /help, both have long finished loading.
  const { commandDefinitions } = await import("./index.ts");
  const guildId = interaction.guildId;
  // The server's text-command settings, so /help shows its own prefix. A
  // failed read only costs that: the default is shown instead.
  const moderation = guildId ? await getGuildConfig(guildId).then((c) => c.moderation ?? null).catch(() => null) : null;

  await finish(
    bot,
    interaction,
    helpMessage(commandDefinitions, {
      ja: interaction.locale?.startsWith("ja") ?? false,
      brand: deployment.brandName,
      // Opens the dashboard on this server; in a DM there isn't one to pick.
      dashboardUrl: guildId ? `${env.DASHBOARD_URL}/guilds/${guildId}` : env.DASHBOARD_URL,
      docsUrl: DOCS_URL,
      supportUrl: deployment.supportUrl || (deployment.mode === "platform" ? PLATFORM_SUPPORT_URL : ""),
      ids: await commandIds(bot),
      prefix: moderation?.prefix,
      textCommands: moderation ? moderation.textCommandsEnabled : true,
    }),
  );
}

/**
 * Command ids, for mentions people can click. Fetched once and kept: an id
 * only changes when a command is deleted and re-created, and every deploy
 * restarts the process anyway. A failed or slow fetch costs only the
 * clickability, so it gives up after two seconds and isn't remembered.
 */
let cachedIds: Map<string, string> | null = null;

async function commandIds(bot: AppealyBot): Promise<Map<string, string>> {
  if (cachedIds) return cachedIds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const commands = await Promise.race([
      bot.rest.getGlobalApplicationCommands(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out after 2s")), 2_000);
      }),
    ]);
    cachedIds = new Map(commands.map((c) => [c.name, String(c.id)]));
    return cachedIds;
  } catch (err) {
    logger.warn("Couldn't fetch command ids for /help; commands are listed as plain text", {
      error: String(err),
    });
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}
