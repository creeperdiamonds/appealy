// api/src/routes/dmTemplates.ts
// Custom Message Editor: configure per-form Submission/Acceptance/Denial
// DM templates. Mounted at /api/guilds/:guildId/forms/:formId/dm-templates

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import type { DmTemplateDTO } from "../../../shared/types/index.ts";

export const dmTemplatesRouter = Router({ mergeParams: true });

const templateSchema = z.object({
  type: z.enum(["submission", "acceptance", "denial"]),
  enabled: z.boolean().default(true),
  title: z.string().max(256).nullable().optional(),
  body: z.string().min(1).max(4000),
  color: z.number().int().nullable().optional(),
});

dmTemplatesRouter.use(requireGuildAccess);

async function assertFormInGuild(guildId: bigint, formId: string) {
  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, formId), eq(schema.forms.guildId, guildId)),
  });
  return form;
}

dmTemplatesRouter.get("/", async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const formId = req.params.formId;
  if (!(await assertFormInGuild(guildId, formId))) return res.status(404).json({ error: "form_not_found" });

  const templates = await db.query.dmTemplates.findMany({ where: eq(schema.dmTemplates.formId, formId) });
  res.json(templates.map(toDTO));
});

dmTemplatesRouter.put("/:type", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const formId = req.params.formId;
  const type = req.params.type as "submission" | "acceptance" | "denial";

  if (!(await assertFormInGuild(guildId, formId))) return res.status(404).json({ error: "form_not_found" });

  const parsed = templateSchema.safeParse({ ...req.body, type });
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;

  const [upserted] = await db
    .insert(schema.dmTemplates)
    .values({
      formId,
      type: data.type,
      enabled: data.enabled,
      title: data.title ?? null,
      body: data.body,
      color: data.color ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.dmTemplates.formId, schema.dmTemplates.type],
      set: {
        enabled: data.enabled,
        title: data.title ?? null,
        body: data.body,
        color: data.color ?? null,
      },
    })
    .returning();

  res.json(toDTO(upserted));
});

function toDTO(t: typeof schema.dmTemplates.$inferSelect): DmTemplateDTO {
  return {
    id: t.id,
    formId: t.formId,
    type: t.type,
    enabled: t.enabled,
    title: t.title,
    body: t.body,
    color: t.color,
  };
}
