// api/src/routes/moderation.ts
// Text moderation command settings (?ban, ?kick, ?mute…): on/off, the prefix,
// and which roles may use them. One row per guild (moderation_configs).
// Mounted at /api/guilds/:guildId/moderation.
//
// A guild that never saved has no row; GET answers with the defaults the bot
// uses in that case (on, "?", no role limit), so the page shows what is
// actually in effect.

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { routeParams } from "../utils/routeParams.ts";
import { db, schema } from "../db/client.ts";
import { requireAdminAccess, requireGuildAccess } from "../middleware/guildAccess.ts";

export const moderationRouter = Router({ mergeParams: true });

export interface ModerationConfigDTO {
  textCommandsEnabled: boolean;
  prefix: string;
  allowedRoleIds: string[];
}

const DEFAULTS: ModerationConfigDTO = { textCommandsEnabled: true, prefix: "?", allowedRoleIds: [] };

// The same rule as validPrefix() in bot/src/services/modCommands.ts: 1-5
// characters, no spaces or backticks, and not starting with "/" "@" "<" "#"
// ":", which Discord gives its own meaning.
const PREFIX = /^[^\s/@<#:`][^\s`]{0,4}$/;

const body = z.object({
  textCommandsEnabled: z.boolean(),
  prefix: z.string().regex(PREFIX, "1-5 characters, no spaces, and not starting with / @ < # :"),
  allowedRoleIds: z.array(z.string().regex(/^\d{17,20}$/)).max(50),
});

moderationRouter.use(requireGuildAccess);

moderationRouter.get("/", async (req, res) => {
  const row = await db.query.moderationConfigs.findFirst({
    where: eq(schema.moderationConfigs.guildId, BigInt(routeParams(req).guildId)),
  });
  res.json(row ? toDTO(row) : DEFAULTS);
});

moderationRouter.put("/", requireAdminAccess, async (req, res) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const guildId = BigInt(routeParams(req).guildId);
  const values = { guildId, ...parsed.data, allowedRoleIds: [...new Set(parsed.data.allowedRoleIds)] };
  const [row] = await db
    .insert(schema.moderationConfigs)
    .values(values)
    .onConflictDoUpdate({ target: schema.moderationConfigs.guildId, set: { ...values, updatedAt: new Date() } })
    .returning();
  res.json(toDTO(row));
});

function toDTO(c: typeof schema.moderationConfigs.$inferSelect): ModerationConfigDTO {
  return { textCommandsEnabled: c.textCommandsEnabled, prefix: c.prefix, allowedRoleIds: c.allowedRoleIds };
}
