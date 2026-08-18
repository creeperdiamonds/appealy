// api/src/routes/appealConfig.ts
//
// CRUD for a guild's single ban-appeal config row (shared/schema/schema.ts's
// appealConfigs — see that comment for the full design). Mounted at
// /api/guilds/:guildId/appeal-config. Unlike forms.ts there's no list/create
// of multiple resources — this is a singleton-per-guild upsert, same
// pattern as welcomer.ts / antiRaid.ts / verification.ts.

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import type { AppealConfigDTO } from "../../../shared/types/index.ts";

export const appealConfigRouter = Router({ mergeParams: true });

const appealConfigSchema = z.object({
  enabled: z.boolean().default(false),
  formId: z.string().nullable().default(null),
  dmOnBanEnabled: z.boolean().default(true),
  dmOnBanNote: z.string().max(1000).nullable().default(null),
  autoUnbanOnAccept: z.boolean().default(true),
});

appealConfigRouter.use(requireGuildAccess);

appealConfigRouter.get("/", async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const config = await db.query.appealConfigs.findFirst({ where: eq(schema.appealConfigs.guildId, guildId) });
  res.json(toDTO(guildId, config));
});

appealConfigRouter.put("/", requireAdminAccess, async (req, res) => {
  const parsed = appealConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });

  const guildId = BigInt(routeParams(req).guildId);
  const data = parsed.data;

  // A designated appeal form, if any, must actually exist in this guild
  // and actually be kind = "appeal" — otherwise dmOnBanEnabled would
  // silently do nothing (or worse, point at a normal application form
  // and DM a banned user something that makes no sense for their
  // situation).
  if (data.formId) {
    const form = await db.query.forms.findFirst({
      where: and(eq(schema.forms.id, data.formId), eq(schema.forms.guildId, guildId)),
    });
    if (!form) {
      return res.status(400).json({ error: "invalid_body", detail: { formErrors: ["formId does not reference a form in this guild."] } });
    }
    if (form.kind !== "appeal") {
      return res.status(400).json({
        error: "invalid_body",
        detail: { formErrors: ['formId must reference a form with kind "appeal".'] },
      });
    }
  }

  const [config] = await db
    .insert(schema.appealConfigs)
    .values({
      guildId,
      enabled: data.enabled,
      formId: data.formId,
      dmOnBanEnabled: data.dmOnBanEnabled,
      dmOnBanNote: data.dmOnBanNote,
      autoUnbanOnAccept: data.autoUnbanOnAccept,
    })
    .onConflictDoUpdate({
      target: schema.appealConfigs.guildId,
      set: {
        enabled: data.enabled,
        formId: data.formId,
        dmOnBanEnabled: data.dmOnBanEnabled,
        dmOnBanNote: data.dmOnBanNote,
        autoUnbanOnAccept: data.autoUnbanOnAccept,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json(toDTO(guildId, config));
});

function toDTO(guildId: bigint, config: typeof schema.appealConfigs.$inferSelect | undefined): AppealConfigDTO {
  if (!config) {
    // No row yet — report the same defaults the schema would apply on
    // first insert, so the dashboard can render a sensible "not set up
    // yet" form without a separate has-config flag.
    return {
      guildId: guildId.toString(),
      enabled: false,
      formId: null,
      dmOnBanEnabled: true,
      dmOnBanNote: null,
      autoUnbanOnAccept: true,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    guildId: config.guildId.toString(),
    enabled: config.enabled,
    formId: config.formId,
    dmOnBanEnabled: config.dmOnBanEnabled,
    dmOnBanNote: config.dmOnBanNote,
    autoUnbanOnAccept: config.autoUnbanOnAccept,
    updatedAt: config.updatedAt.toISOString(),
  };
}
