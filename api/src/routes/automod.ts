// api/src/routes/automod.ts
//
// Discord's AutoMod, editable from the dashboard. Mounted at
// /api/guilds/:guildId/automod.
//
// Why it exists: Discord's apps can't edit AutoMod on a phone, and the
// dashboard works on one. The rules stay in Discord. This route checks who is
// asking and that the rule is inside Discord's limits, then hands the change
// to the bot, which holds the token (bot/src/services/automodService.ts).
//
// Admins only, for reading as well as writing. Discord only shows AutoMod to
// people with Manage Server, and the dashboard's admin level is exactly that:
// owner, Administrator or Manage Server (filterManageableGuilds). A delegated
// manager has no Discord permission at all, and letting one through would
// hand them Appealy's.
//
// No plan limits: every server gets every rule Discord allows it.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { routeParams } from "../utils/routeParams.ts";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import {
  automodCreate,
  automodDelete,
  automodEdit,
  automodList,
  botCallFailure,
} from "../services/botBridge.ts";
import { inviteUrlFor } from "./auth.ts";
import { checkRule, isKnownTrigger, type AutomodRuleInput } from "../../../shared/services/automodRules.ts";
import { logger } from "../utils/logger.ts";

export const automodRouter = Router({ mergeParams: true });

/**
 * Manage Server, which Discord requires for anything AutoMod. Not on the
 * normal invite, because most servers never open this page and it's a lot to
 * ask for up front. The page offers it, through inviteUrlFor, when it's needed.
 */
const MANAGE_GUILD = 1n << 5n;

const snowflake = z.string().regex(/^\d{17,20}$/);

// Shapes only. Discord's limits are checked by checkRule, which knows which
// ones apply to which kind of rule.
const ruleSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  keywords: z.array(z.string()),
  regexPatterns: z.array(z.string()),
  allowList: z.array(z.string()),
  presets: z.array(z.number().int()),
  mentionLimit: z.number().int().nullable(),
  mentionRaidProtection: z.boolean(),
  block: z.boolean(),
  blockMessage: z.string(),
  alertChannelId: snowflake.nullable(),
  timeoutSeconds: z.number().int().nullable(),
  blockInteractions: z.boolean(),
  exemptRoles: z.array(snowflake),
  exemptChannels: z.array(snowflake),
});

const bodySchema = z.object({ triggerType: z.number().int(), rule: ruleSchema });

automodRouter.use(requireGuildAccess, requireAdminAccess);

automodRouter.get("/", async (req, res) => {
  const guildId = routeParams(req).guildId;
  // Offered even when the permission is already there: the same link repairs
  // a server whose invite predates a permission Appealy now asks for.
  const grantUrl = inviteUrlFor(guildId, MANAGE_GUILD);

  // So the editor can say whether an AutoMod timeout will reach the member
  // with an appeal button (bot/src/events/guildMemberUpdate.ts).
  const appeal = await db.query.appealConfigs.findFirst({
    where: eq(schema.appealConfigs.guildId, BigInt(guildId)),
  });
  const timeoutAppeals =
    appeal?.timeoutEnabled && appeal.timeoutFormId ? { minSeconds: appeal.timeoutMinSeconds } : null;

  try {
    const result = await automodList(guildId);
    if ("missingPermission" in result) {
      return res.json({ missingPermission: true, rules: [], grantUrl, timeoutAppeals });
    }
    res.json({ missingPermission: false, rules: result.rules, grantUrl, timeoutAppeals });
  } catch (err) {
    res.status(502).json(botCallFailure(err));
  }
});

automodRouter.post("/rules", async (req, res) => {
  const body = parseBody(req, res);
  if (!body) return;
  try {
    const { rule } = await automodCreate(
      routeParams(req).guildId,
      body.triggerType,
      body.rule,
      String(req.userId),
    );
    await audit(req, "automod.create", rule.id, { name: rule.name, triggerType: rule.triggerType });
    res.status(201).json(rule);
  } catch (err) {
    failure(res, err);
  }
});

automodRouter.patch("/rules/:ruleId", async (req, res) => {
  const ruleId = routeParams(req).ruleId;
  if (!snowflake.safeParse(ruleId).success) return res.status(400).json({ error: "invalid_rule_id" });
  const body = parseBody(req, res);
  if (!body) return;
  try {
    const { rule } = await automodEdit(routeParams(req).guildId, ruleId, body.rule, String(req.userId));
    await audit(req, "automod.update", rule.id, { name: rule.name, enabled: rule.enabled });
    res.json(rule);
  } catch (err) {
    failure(res, err);
  }
});

automodRouter.delete("/rules/:ruleId", async (req, res) => {
  const ruleId = routeParams(req).ruleId;
  if (!snowflake.safeParse(ruleId).success) return res.status(400).json({ error: "invalid_rule_id" });
  try {
    await automodDelete(routeParams(req).guildId, ruleId, String(req.userId));
    await audit(req, "automod.delete", ruleId, null);
    res.json({ deleted: true });
  } catch (err) {
    failure(res, err);
  }
});

/**
 * The body, checked against Discord's limits, or null once a 400 has been
 * sent. Limit problems come back in zod's flatten shape, so the dashboard
 * shows them next to the field they belong to, the same as a shape error.
 */
function parseBody(req: Request, res: Response): { triggerType: number; rule: AutomodRuleInput } | null {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
    return null;
  }
  const { triggerType, rule } = parsed.data;
  if (!isKnownTrigger(triggerType)) {
    res
      .status(400)
      .json({ error: "invalid_body", detail: "That isn't a kind of AutoMod rule Appealy can set up." });
    return null;
  }
  const problems = checkRule(triggerType, rule);
  if (problems.length > 0) {
    const fieldErrors: Record<string, string[]> = {};
    for (const p of problems) (fieldErrors[p.field] ??= []).push(p.message);
    res.status(400).json({ error: "outside_discord_limits", detail: { formErrors: [], fieldErrors } });
    return null;
  }
  return { triggerType, rule };
}

/**
 * 422 when Discord refused something the admin can fix (the bot has already
 * worded it; see AutomodRefusal), 502 when the bot couldn't be reached.
 */
function failure(res: Response, err: unknown) {
  const refused = (err as { botStatus?: number }).botStatus === 422;
  res.status(refused ? 422 : 502).json(botCallFailure(err));
}

/**
 * Records the change on the Operations page's audit log.
 *
 * After the fact, and never fatal: the change has already happened in Discord,
 * and Discord's own audit log carries it too, with the admin's name in the
 * reason (automodService.ts). Failing the request here would tell someone a
 * saved rule wasn't saved.
 */
async function audit(
  req: Request,
  action: string,
  resourceId: string,
  changes: Record<string, unknown> | null,
) {
  try {
    await db.insert(schema.dashboardAuditLogs).values({
      guildId: BigInt(routeParams(req).guildId),
      userId: req.userId!,
      action,
      resourceType: "automod_rule",
      resourceId,
      changes,
    });
  } catch (err) {
    logger.warn("Could not record an AutoMod change in the audit log", {
      action,
      resourceId,
      error: String(err),
    });
  }
}
