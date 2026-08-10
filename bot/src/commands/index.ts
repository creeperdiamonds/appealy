// bot/src/commands/index.ts
// Slash command registry + router. Each command's definition (for
// bulk-overwrite registration) and its execute() handler live together in
// its own file, exported here.

import type { Interaction, CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { logger } from "../utils/logger.ts";

import * as panelCreate from "./panelCreate.ts";
import * as formList from "./formList.ts";
import * as dashboard from "./dashboard.ts";
import * as apply from "./apply.ts";
import * as pollCreate from "./pollCreate.ts";
import * as exportApplications from "./exportApplications.ts";
import * as ticketPanel from "./ticketPanel.ts";
import * as giveaway from "./giveaway.ts";
import * as verifySetup from "./verifySetup.ts";
import * as resetCooldown from "./resetCooldown.ts";
import * as ping from "./ping.ts";
import * as botStats from "./botStats.ts";
import * as roleMenu from "./roleMenu.ts";
import * as antiRaid from "./antiRaid.ts";
import * as exportData from "./exportData.ts";
import * as importAppy from "./importAppy.ts";

const commands = [
  panelCreate,
  formList,
  dashboard,
  apply,
  pollCreate,
  exportApplications,
  ticketPanel,
  giveaway,
  verifySetup,
  resetCooldown,
  ping,
  botStats,
  roleMenu,
  antiRaid,
  exportData,
  importAppy,
];

/** Commands that implement an autocomplete() export get routed
 * ApplicationCommandAutocomplete interactions automatically. */
export async function routeAutocomplete(bot: AppealyBot, interaction: Interaction) {
  const name = interaction.data?.name;
  const command = commands.find((c) => c.definition.name === name);
  if (command && "autocomplete" in command && typeof command.autocomplete === "function") {
    await command.autocomplete(bot, interaction);
  }
}

export const commandDefinitions: CreateApplicationCommand[] = commands.map((c) => c.definition);

export async function routeSlashCommand(bot: AppealyBot, interaction: Interaction) {
  const name = interaction.data?.name;
  const command = commands.find((c) => c.definition.name === name);
  if (!command) {
    logger.warn("Unknown slash command invoked", { name });
    return;
  }
  await command.execute(bot, interaction);
}

/** Call once on startup (or from a separate deploy script) to sync commands
 * with Discord. Guild-scoped registration is instant; global registration
 * can take up to an hour to propagate. */
export async function registerCommands(bot: AppealyBot, guildId?: bigint) {
  if (guildId) {
    await bot.helpers.upsertGuildApplicationCommands(guildId, commandDefinitions);
  } else {
    await bot.helpers.upsertGlobalApplicationCommands(commandDefinitions);
  }
  logger.info("Slash commands registered", { scope: guildId ? guildId.toString() : "global" });
}
