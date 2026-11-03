// api/src/routes/moderation.ts
// Moderation command settings (/ban, /kick, /mute… and "@Appealy ban"):
// whether the mention form works, and which roles may use them. One row per
// guild (moderation_configs). Mounted at /api/guilds/:guildId/moderation.
//
// A guild that never saved has no row; GET answers with the defaults the bot
// uses in that case (on, no role limit), so the page shows what is actually
// in effect.
//
// The prefix column is left in the table but no longer used: the "?ban"
// prefix commands were removed on 2026-11-03 (bot/src/services/modCommands.ts
// says why). A dashboard tab still open from before may send it; it's ignored.

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { routeParams } from "../utils/routeParams.ts";
import { db, schema } from "../db/client.ts";
import { requireAdminAccess, requireGuildAccess } from "../middleware/guildAccess.ts";

export const moderationRouter = Router({ mergeParams: true });

export interface ModerationConfigDTO {
  textCommandsEnabled: boolean;
  allowedRoleIds: string[];
}

const DEFAULTS: ModerationConfigDTO = { textCommandsEnabled: true, allowedRoleIds: [] };

const body = z.object({
  textCommandsEnabled: z.boolean(),
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
  return { textCommandsEnabled: c.textCommandsEnabled, allowedRoleIds: c.allowedRoleIds };
}
