// api/src/routes/appealConfig.ts
//
// CRUD for a guild's single appeal config row (shared/schema/schema.ts's
// appealConfigs — see that comment for the full design): ban appeals, plus
// timeout and restriction appeals, each with its own form. Mounted at
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

// The timeout and restriction fields are optional rather than defaulted. A
// dashboard tab opened before they existed still saves the ban settings it
// knows about, and a defaulted field would silently switch the others off.
const appealConfigSchema = z.object({
  enabled: z.boolean().default(false),
  formId: z.string().nullable().default(null),
  dmOnBanEnabled: z.boolean().default(true),
  dmOnBanNote: z.string().max(1000).nullable().default(null),
  autoUnbanOnAccept: z.boolean().default(true),

  timeoutEnabled: z.boolean().optional(),
  timeoutFormId: z.string().nullable().optional(),
  // Discord caps a timeout at 28 days, so a longer threshold would never fire.
  timeoutMinSeconds: z.number().int().min(0).max(28 * 24 * 3600).optional(),
  dmOnTimeoutNote: z.string().max(1000).nullable().optional(),
  liftTimeoutOnAccept: z.boolean().optional(),

  restrictionEnabled: z.boolean().optional(),
  restrictionRoleIds: z.array(z.string().regex(/^\d{17,20}$/)).max(25).optional(),
  restrictionFormId: z.string().nullable().optional(),
  dmOnRestrictionNote: z.string().max(1000).nullable().optional(),
  liftRestrictionOnAccept: z.boolean().optional(),
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

  // Every designated form must actually exist in this guild and actually be
  // kind = "appeal" — otherwise the notice would silently do nothing, or
  // worse, DM a punished member an ordinary application that makes no sense
  // for their situation.
  for (const [field, id] of [
    ["formId", data.formId],
    ["timeoutFormId", data.timeoutFormId],
    ["restrictionFormId", data.restrictionFormId],
  ] as const) {
    if (!id) continue;
    const form = await db.query.forms.findFirst({
      where: and(eq(schema.forms.id, id), eq(schema.forms.guildId, guildId)),
    });
    if (!form) {
      return res.status(400).json({ error: "invalid_body", detail: { formErrors: [`${field} does not reference a form in this guild.`] } });
    }
    if (form.kind !== "appeal") {
      return res.status(400).json({
        error: "invalid_body",
        detail: { formErrors: [`${field} must reference a form with kind "appeal".`] },
      });
    }
  }

  // Only the fields actually sent — see the schema comment above.
  const optional = Object.fromEntries(
    (
      [
        "timeoutEnabled",
        "timeoutFormId",
        "timeoutMinSeconds",
        "dmOnTimeoutNote",
        "liftTimeoutOnAccept",
        "restrictionEnabled",
        "restrictionRoleIds",
        "restrictionFormId",
        "dmOnRestrictionNote",
        "liftRestrictionOnAccept",
      ] as const
    )
      .filter((k) => data[k] !== undefined)
      .map((k) => [k, data[k]]),
  );
  const values = {
    enabled: data.enabled,
    formId: data.formId,
    dmOnBanEnabled: data.dmOnBanEnabled,
    dmOnBanNote: data.dmOnBanNote,
    autoUnbanOnAccept: data.autoUnbanOnAccept,
    ...optional,
  };

  const [config] = await db
    .insert(schema.appealConfigs)
    .values({ guildId, ...values })
    .onConflictDoUpdate({
      target: schema.appealConfigs.guildId,
      set: { ...values, updatedAt: new Date() },
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
      timeoutEnabled: false,
      timeoutFormId: null,
      timeoutMinSeconds: 3600,
      dmOnTimeoutNote: null,
      liftTimeoutOnAccept: true,
      restrictionEnabled: false,
      restrictionRoleIds: [],
      restrictionFormId: null,
      dmOnRestrictionNote: null,
      liftRestrictionOnAccept: true,
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
    timeoutEnabled: config.timeoutEnabled,
    timeoutFormId: config.timeoutFormId,
    timeoutMinSeconds: config.timeoutMinSeconds,
    dmOnTimeoutNote: config.dmOnTimeoutNote,
    liftTimeoutOnAccept: config.liftTimeoutOnAccept,
    restrictionEnabled: config.restrictionEnabled,
    restrictionRoleIds: config.restrictionRoleIds,
    restrictionFormId: config.restrictionFormId,
    dmOnRestrictionNote: config.dmOnRestrictionNote,
    liftRestrictionOnAccept: config.liftRestrictionOnAccept,
    updatedAt: config.updatedAt.toISOString(),
  };
}
