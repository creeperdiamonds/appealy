// api/src/routes/polls.ts
// Poll Management System: create/schedule/publish community polls.
// Mounted at /api/guilds/:guildId/polls

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { requestPollPublish } from "../services/botBridge.ts";
import type { PollDTO } from "../../../shared/types/index.ts";

export const pollsRouter = Router({ mergeParams: true });

const pollSchema = z.object({
  channelId: z.string(),
  question: z.string().min(1).max(300),
  options: z
    .array(z.object({ id: z.string().optional(), label: z.string().min(1).max(100), emoji: z.string().optional() }))
    .min(2)
    .max(10), // Discord select menu option cap
  allowMultiselect: z.boolean().default(false),
  scheduledFor: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional(),
});

pollsRouter.use(requireGuildAccess);

pollsRouter.get("/", async (req, res) => {
  const polls = await db.query.polls.findMany({ where: eq(schema.polls.guildId, BigInt(routeParams(req).guildId)) });
  res.json(polls.map(toDTO));
});

pollsRouter.post("/", requireAdminAccess, async (req, res) => {
  const parsed = pollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const optionsWithIds = data.options.map((o, i) => ({
    id: o.id ?? crypto.randomUUID(),
    label: o.label,
    emoji: o.emoji,
  }));

  const [poll] = await db
    .insert(schema.polls)
    .values({
      guildId,
      channelId: BigInt(data.channelId),
      question: data.question,
      options: optionsWithIds,
      allowMultiselect: data.allowMultiselect,
      status: data.scheduledFor ? "scheduled" : "draft",
      scheduledFor: data.scheduledFor ? new Date(data.scheduledFor) : null,
      closesAt: data.closesAt ? new Date(data.closesAt) : null,
      createdBy: req.userId!,
    })
    .returning();

  res.status(201).json(toDTO(poll));
});

pollsRouter.patch("/:pollId", requireAdminAccess, async (req, res) => {
  const parsed = pollSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);
  const pollId = routeParams(req).pollId;

  const existing = await db.query.polls.findFirst({
    where: and(eq(schema.polls.id, pollId), eq(schema.polls.guildId, guildId)),
  });
  if (!existing) return res.status(404).json({ error: "poll_not_found" });
  if (existing.status === "published" || existing.status === "closed") {
    return res.status(409).json({ error: "poll_already_published", detail: "Published polls cannot be edited." });
  }

  const updateSet: Record<string, unknown> = {};
  if (data.channelId !== undefined) updateSet.channelId = BigInt(data.channelId);
  if (data.question !== undefined) updateSet.question = data.question;
  if (data.options !== undefined) {
    updateSet.options = data.options.map((o) => ({ id: o.id ?? crypto.randomUUID(), label: o.label, emoji: o.emoji }));
  }
  if (data.allowMultiselect !== undefined) updateSet.allowMultiselect = data.allowMultiselect;
  if (data.scheduledFor !== undefined) {
    updateSet.scheduledFor = data.scheduledFor ? new Date(data.scheduledFor) : null;
    updateSet.status = data.scheduledFor ? "scheduled" : "draft";
  }
  if (data.closesAt !== undefined) updateSet.closesAt = data.closesAt ? new Date(data.closesAt) : null;

  const [updated] = await db
    .update(schema.polls)
    .set(updateSet)
    .where(eq(schema.polls.id, pollId))
    .returning();

  res.json(toDTO(updated));
});

pollsRouter.post("/:pollId/publish", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const poll = await db.query.polls.findFirst({
    where: and(eq(schema.polls.id, routeParams(req).pollId), eq(schema.polls.guildId, guildId)),
  });
  if (!poll) return res.status(404).json({ error: "poll_not_found" });
  if (poll.status === "published" || poll.status === "closed") {
    return res.status(409).json({ error: "already_published" });
  }

  try {
    await requestPollPublish(poll.id);
  } catch (err) {
    return res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
  res.status(202).json({ status: "publish_requested" });
});

pollsRouter.delete("/:pollId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const result = await db
    .delete(schema.polls)
    .where(and(eq(schema.polls.id, routeParams(req).pollId), eq(schema.polls.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "poll_not_found" });
  res.status(204).send();
});

function toDTO(poll: typeof schema.polls.$inferSelect): PollDTO {
  return {
    id: poll.id,
    guildId: poll.guildId.toString(),
    channelId: poll.channelId.toString(),
    messageId: poll.messageId?.toString() ?? null,
    question: poll.question,
    options: poll.options,
    allowMultiselect: poll.allowMultiselect,
    status: poll.status,
    scheduledFor: poll.scheduledFor?.toISOString() ?? null,
    closesAt: poll.closesAt?.toISOString() ?? null,
  };
}
