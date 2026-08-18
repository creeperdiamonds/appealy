// api/src/routes/stickyMessages.ts
// Mounted at /api/guilds/:guildId/sticky-messages

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { requestStickyMessagePublish } from "../services/botBridge.ts";

export const stickyMessagesRouter = Router({ mergeParams: true });

const stickySchema = z.object({
  channelId: z.string(),
  content: z.string().min(1).max(2000),
  repostAfterMessages: z.number().int().min(1).max(100).default(5),
  active: z.boolean().default(true),
});

stickyMessagesRouter.use(requireGuildAccess);

stickyMessagesRouter.get("/", async (req, res) => {
  const rows = await db.select().from(schema.stickyMessages).where(eq(schema.stickyMessages.guildId, BigInt(routeParams(req).guildId)));
  res.json(rows.map(toDTO));
});

stickyMessagesRouter.post("/", requireAdminAccess, async (req, res) => {
  const parsed = stickySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const existing = await db.query.stickyMessages.findFirst({ where: eq(schema.stickyMessages.channelId, BigInt(data.channelId)) });
  if (existing) {
    return res.status(409).json({ error: "channel_already_has_sticky", detail: "This channel already has a sticky message. Edit or delete it first." });
  }

  const [created] = await db
    .insert(schema.stickyMessages)
    .values({
      guildId,
      channelId: BigInt(data.channelId),
      content: data.content,
      repostAfterMessages: data.repostAfterMessages,
      active: data.active,
    })
    .returning();

  if (created.active) {
    await requestStickyMessagePublish(created.id).catch(() => {});
  }

  res.status(201).json(toDTO(created));
});

stickyMessagesRouter.patch("/:stickyId", requireAdminAccess, async (req, res) => {
  const parsed = stickySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const updateSet: Record<string, unknown> = {};
  if (data.content !== undefined) updateSet.content = data.content;
  if (data.repostAfterMessages !== undefined) updateSet.repostAfterMessages = data.repostAfterMessages;
  if (data.active !== undefined) updateSet.active = data.active;
  if (data.channelId !== undefined) updateSet.channelId = BigInt(data.channelId);

  const [updated] = await db
    .update(schema.stickyMessages)
    .set(updateSet)
    .where(and(eq(schema.stickyMessages.id, routeParams(req).stickyId), eq(schema.stickyMessages.guildId, guildId)))
    .returning();
  if (!updated) return res.status(404).json({ error: "sticky_not_found" });

  if (data.content !== undefined && updated.active) {
    await requestStickyMessagePublish(updated.id).catch(() => {});
  }

  res.json(toDTO(updated));
});

stickyMessagesRouter.delete("/:stickyId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const result = await db
    .delete(schema.stickyMessages)
    .where(and(eq(schema.stickyMessages.id, routeParams(req).stickyId), eq(schema.stickyMessages.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "sticky_not_found" });
  res.status(204).send();
});

function toDTO(s: typeof schema.stickyMessages.$inferSelect) {
  return {
    id: s.id,
    guildId: s.guildId.toString(),
    channelId: s.channelId.toString(),
    content: s.content,
    repostAfterMessages: s.repostAfterMessages,
    active: s.active,
  };
}
