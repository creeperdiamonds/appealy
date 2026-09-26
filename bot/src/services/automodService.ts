// bot/src/services/automodService.ts
//
// Discord's AutoMod rules, read and written for the dashboard's AutoMod page.
//
// The API holds no bot token, so every dashboard change to AutoMod comes
// through here by way of the control server. Nothing is stored on our side:
// Discord's copy is the only one, and every read asks Discord, so a rule
// changed in Discord's own settings shows up in the dashboard straight away.
//
// Raw requests rather than Discordeno's AutoMod helpers. Its types predate
// several of Discord's fields (custom_message, mention_raid_protection_enabled,
// regex patterns on edit), and going through its camelCase conversion would
// mean rebuilding exactly the snake_case that shared/services/automodRules.ts
// already speaks.
//
// Needs Manage Server, which is not on Appealy's normal invite: a server grants
// it when it turns this page on. Listing without it is not an error, it's the
// page's "give Appealy permission" state.

import type { AppealyBot } from "../core/client.ts";
import {
  createFields,
  describeRejection,
  fromDiscord,
  isKnownTrigger,
  toDiscord,
  type AutomodRule,
  type AutomodRuleInput,
  type DiscordAutomodRule,
} from "../../../shared/services/automodRules.ts";
import { describeDiscordError } from "../utils/discordError.ts";
import { resolveUsers } from "./userResolve.ts";

/** A Discord refusal, worded for the person who pressed Save. */
export class AutomodRefusal extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = "AutomodRefusal";
  }
}

const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const INVALID_FORM_BODY = 50035;

export async function listRules(
  bot: AppealyBot,
  guildId: string,
): Promise<{ rules: AutomodRule[] } | { missingPermission: true }> {
  try {
    const raw = await bot.rest.makeRequest<DiscordAutomodRule[]>(
      "GET",
      bot.rest.routes.guilds.automod.rules(guildId),
    );
    const self = bot.id.toString();
    return { rules: raw.map((r) => fromDiscord(r, self)) };
  } catch (err) {
    const info = describeDiscordError(err);
    if (info.code === MISSING_PERMISSIONS || info.code === MISSING_ACCESS) {
      return { missingPermission: true };
    }
    throw err;
  }
}

export async function createRule(
  bot: AppealyBot,
  guildId: string,
  triggerType: number,
  input: AutomodRuleInput,
  actorId: string,
): Promise<AutomodRule> {
  if (!isKnownTrigger(triggerType)) throw new AutomodRefusal("Appealy can't create that kind of rule.");
  const body = { ...toDiscord(triggerType, input), ...createFields(triggerType) };
  try {
    const created = await bot.rest.makeRequest<DiscordAutomodRule>(
      "POST",
      bot.rest.routes.guilds.automod.rules(guildId),
      { body, reason: await reasonFor(bot, actorId, "Created") },
    );
    return fromDiscord(created, bot.id.toString());
  } catch (err) {
    throw refusal(err, input.timeoutSeconds !== null);
  }
}

/**
 * Saves the editor's settings over a rule.
 *
 * Reads the rule first, so anything Discord knows that the editor doesn't
 * (see toDiscord) goes back unchanged instead of being wiped.
 */
export async function editRule(
  bot: AppealyBot,
  guildId: string,
  ruleId: string,
  input: AutomodRuleInput,
  actorId: string,
): Promise<AutomodRule> {
  try {
    const route = bot.rest.routes.guilds.automod.rule(guildId, ruleId);
    const existing = await bot.rest.makeRequest<DiscordAutomodRule>("GET", route);
    if (!isKnownTrigger(existing.trigger_type)) {
      throw new AutomodRefusal(
        "This rule uses a kind of AutoMod Appealy doesn't know yet.",
        "Edit it in Discord's own AutoMod settings.",
      );
    }
    const updated = await bot.rest.makeRequest<DiscordAutomodRule>("PATCH", route, {
      body: toDiscord(existing.trigger_type, input, existing),
      reason: await reasonFor(bot, actorId, "Changed"),
    });
    return fromDiscord(updated, bot.id.toString());
  } catch (err) {
    if (err instanceof AutomodRefusal) throw err;
    throw refusal(err, input.timeoutSeconds !== null);
  }
}

/** Deleting a rule that's already gone (deleted in Discord meanwhile) counts as done. */
export async function deleteRule(bot: AppealyBot, guildId: string, ruleId: string, actorId: string) {
  try {
    await bot.rest.makeRequest("DELETE", bot.rest.routes.guilds.automod.rule(guildId, ruleId), {
      reason: await reasonFor(bot, actorId, "Deleted"),
    });
  } catch (err) {
    if (describeDiscordError(err).status === 404) return;
    throw refusal(err, false);
  }
}

/**
 * The line Discord's audit log shows beside the change.
 *
 * Without it every change made through the dashboard reads as Appealy's own,
 * and a server's admins can't tell which of them made it. Discord shows the
 * reason next to the entry, so the name goes there.
 */
async function reasonFor(bot: AppealyBot, actorId: string, verb: string): Promise<string> {
  const [user] = await resolveUsers(bot, [actorId]).catch(() => []);
  return `${verb} in the Appealy dashboard by ${user?.username ?? actorId} (${actorId})`;
}

/** Turns Discord's rejection into something the dashboard can show as is. */
function refusal(err: unknown, hasTimeout: boolean): Error {
  const info = describeDiscordError(err);

  if (info.code === MISSING_PERMISSIONS || info.code === MISSING_ACCESS) {
    return new AutomodRefusal(
      "Appealy is missing a permission Discord needs for this.",
      hasTimeout
        ? "Changing AutoMod needs Manage Server, and a rule that times people out also needs Timeout Members."
        : "Changing AutoMod needs Manage Server.",
    );
  }
  if (info.code === INVALID_FORM_BODY) {
    const specific = describeRejection(formErrors(err));
    if (specific) return new AutomodRefusal(`Discord didn't accept this rule. ${specific}`);
  }
  if (info.status === 404) {
    return new AutomodRefusal(
      "That rule doesn't exist any more.",
      "It may have been deleted in Discord. Reload the page.",
    );
  }
  return new AutomodRefusal(`Discord didn't accept this rule: ${info.message}`);
}

/**
 * The `errors` object from Discord's response body, wherever the error keeps it.
 *
 * Discordeno puts the response on `cause.body` as text. Walked defensively,
 * like describeDiscordError, because the shape has moved between releases.
 */
function formErrors(err: unknown): unknown {
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth++) {
    const record = cursor as Record<string, unknown>;
    let body = record.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = undefined;
      }
    }
    if (body && typeof body === "object" && "errors" in body) return (body as { errors: unknown }).errors;
    cursor = record.cause;
  }
  return undefined;
}
