// api/src/routes/quickResponses.ts
// Mounted at /api/guilds/:guildId/quick-responses and .../quick-response-categories

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";

export const quickResponsesRouter = Router({ mergeParams: true });

const categorySchema = z.object({
  name: z.string().min(1).max(100),
  sortOrder: z.number().int().default(0),
});

const responseSchema = z.object({
  categoryId: z.string().nullable().optional(),
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(2000),
});

quickResponsesRouter.use(requireGuildAccess);

quickResponsesRouter.get("/categories", async (req, res) => {
  const rows = await db
    .select()
    .from(schema.quickResponseCategories)
    .where(eq(schema.quickResponseCategories.guildId, BigInt(req.params.guildId)));
  res.json(rows);
});

quickResponsesRouter.post("/categories", requireAdminAccess, async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const [created] = await db
    .insert(schema.quickResponseCategories)
    .values({ guildId: BigInt(req.params.guildId), name: parsed.data.name, sortOrder: parsed.data.sortOrder })
    .returning();
  res.status(201).json(created);
});

quickResponsesRouter.delete("/categories/:categoryId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const result = await db
    .delete(schema.quickResponseCategories)
    .where(and(eq(schema.quickResponseCategories.id, req.params.categoryId), eq(schema.quickResponseCategories.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "category_not_found" });
  res.status(204).send();
});

quickResponsesRouter.get("/", async (req, res) => {
  const rows = await db
    .select()
    .from(schema.quickResponses)
    .where(eq(schema.quickResponses.guildId, BigInt(req.params.guildId)));
  res.json(rows.map(toDTO));
});

quickResponsesRouter.post("/", requireAdminAccess, async (req, res) => {
  const parsed = responseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;

  const [created] = await db
    .insert(schema.quickResponses)
    .values({
      guildId: BigInt(req.params.guildId),
      categoryId: data.categoryId ?? null,
      title: data.title,
      body: data.body,
      createdBy: req.userId!,
    })
    .returning();
  res.status(201).json(toDTO(created));
});

quickResponsesRouter.patch("/:responseId", requireAdminAccess, async (req, res) => {
  const parsed = responseSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const guildId = BigInt(req.params.guildId);
  const data = parsed.data;

  const updateSet: Record<string, unknown> = {};
  if (data.title !== undefined) updateSet.title = data.title;
  if (data.body !== undefined) updateSet.body = data.body;
  if (data.categoryId !== undefined) updateSet.categoryId = data.categoryId;

  const [updated] = await db
    .update(schema.quickResponses)
    .set(updateSet)
    .where(and(eq(schema.quickResponses.id, req.params.responseId), eq(schema.quickResponses.guildId, guildId)))
    .returning();
  if (!updated) return res.status(404).json({ error: "response_not_found" });
  res.json(toDTO(updated));
});

quickResponsesRouter.delete("/:responseId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const result = await db
    .delete(schema.quickResponses)
    .where(and(eq(schema.quickResponses.id, req.params.responseId), eq(schema.quickResponses.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "response_not_found" });
  res.status(204).send();
});

function toDTO(r: typeof schema.quickResponses.$inferSelect) {
  return {
    id: r.id,
    guildId: r.guildId.toString(),
    categoryId: r.categoryId,
    title: r.title,
    body: r.body,
    createdBy: r.createdBy.toString(),
    createdAt: r.createdAt.toISOString(),
  };
}
