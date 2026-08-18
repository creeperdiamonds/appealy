// api/src/routes/tickets.ts
// Ticket type (config) CRUD + read-only ticket history.
// Mounted at /api/guilds/:guildId/ticket-configs

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { requestTicketPanelPublish } from "../services/botBridge.ts";
import type { TicketConfigDTO, TicketDTO } from "../../../shared/types/index.ts";

export const ticketsRouter = Router({ mergeParams: true });

const configSchema = z.object({
  name: z.string().min(1).max(100),
  buttonLabel: z.string().min(1).max(80).default("Open Ticket"),
  buttonEmoji: z.string().nullable().optional(),
  channelId: z.string(),
  categoryId: z.string().nullable().optional(),
  channelType: z.enum(["private_channel", "private_thread", "public_thread"]).default("private_channel"),
  supportRoleIds: z.array(z.string()).default([]),
  pingRoleIds: z.array(z.string()).default([]),
  welcomeMessage: z.string().max(1000).default("Thanks for opening a ticket. A member of staff will be with you shortly."),
  ticketNameFormat: z.string().max(100).default("ticket-{username}"),
  maxOpenPerUser: z.number().int().min(1).max(10).default(1),
  leaveAction: z.enum(["none", "close", "notify"]).default("none"),
  transcriptOnClose: z.boolean().default(true),
  transcriptChannelId: z.string().nullable().optional(),
  creatorCanClose: z.boolean().default(true),
  claimingEnabled: z.boolean().default(false),
  ratingEnabled: z.boolean().default(false),
  active: z.boolean().default(true),
});

ticketsRouter.use(requireGuildAccess);

ticketsRouter.get("/", async (req, res) => {
  const configs = await db.select().from(schema.ticketConfigs).where(eq(schema.ticketConfigs.guildId, BigInt(routeParams(req).guildId)));
  res.json(configs.map(toConfigDTO));
});

ticketsRouter.post("/", requireAdminAccess, async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const [created] = await db
    .insert(schema.ticketConfigs)
    .values({
      guildId,
      name: data.name,
      buttonLabel: data.buttonLabel,
      buttonEmoji: data.buttonEmoji ?? null,
      channelId: BigInt(data.channelId),
      categoryId: data.categoryId ? BigInt(data.categoryId) : null,
      channelType: data.channelType,
      supportRoleIds: data.supportRoleIds,
      pingRoleIds: data.pingRoleIds,
      welcomeMessage: data.welcomeMessage,
      ticketNameFormat: data.ticketNameFormat,
      maxOpenPerUser: data.maxOpenPerUser,
      leaveAction: data.leaveAction,
      transcriptOnClose: data.transcriptOnClose,
      transcriptChannelId: data.transcriptChannelId ? BigInt(data.transcriptChannelId) : null,
      creatorCanClose: data.creatorCanClose,
      claimingEnabled: data.claimingEnabled,
      ratingEnabled: data.ratingEnabled,
      active: data.active,
    })
    .returning();

  res.status(201).json(toConfigDTO(created));
});

ticketsRouter.patch("/:configId", requireAdminAccess, async (req, res) => {
  const parsed = configSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);
  const configId = routeParams(req).configId;

  const existing = await db.query.ticketConfigs.findFirst({
    where: and(eq(schema.ticketConfigs.id, configId), eq(schema.ticketConfigs.guildId, guildId)),
  });
  if (!existing) return res.status(404).json({ error: "config_not_found" });

  const updateSet: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of [
    "name",
    "buttonLabel",
    "buttonEmoji",
    "channelType",
    "supportRoleIds",
    "pingRoleIds",
    "welcomeMessage",
    "ticketNameFormat",
    "maxOpenPerUser",
    "leaveAction",
    "transcriptOnClose",
    "creatorCanClose",
    "claimingEnabled",
    "ratingEnabled",
    "active",
  ] as const) {
    if (data[key] !== undefined) updateSet[key] = data[key];
  }
  if (data.channelId !== undefined) updateSet.channelId = BigInt(data.channelId);
  if (data.categoryId !== undefined) updateSet.categoryId = data.categoryId ? BigInt(data.categoryId) : null;
  if (data.transcriptChannelId !== undefined) {
    updateSet.transcriptChannelId = data.transcriptChannelId ? BigInt(data.transcriptChannelId) : null;
  }

  const [updated] = await db.update(schema.ticketConfigs).set(updateSet).where(eq(schema.ticketConfigs.id, configId)).returning();
  res.json(toConfigDTO(updated));
});

ticketsRouter.post("/:configId/publish", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const config = await db.query.ticketConfigs.findFirst({
    where: and(eq(schema.ticketConfigs.id, routeParams(req).configId), eq(schema.ticketConfigs.guildId, guildId)),
  });
  if (!config) return res.status(404).json({ error: "config_not_found" });

  try {
    await requestTicketPanelPublish(config.id);
  } catch (err) {
    return res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
  res.status(202).json({ status: "publish_requested" });
});

ticketsRouter.delete("/:configId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const result = await db
    .delete(schema.ticketConfigs)
    .where(and(eq(schema.ticketConfigs.id, routeParams(req).configId), eq(schema.ticketConfigs.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "config_not_found" });
  res.status(204).send();
});

// Read-only ticket history for a given config, for dashboard review/audit.
ticketsRouter.get("/:configId/tickets", async (req, res) => {
  const rows = await db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.configId, routeParams(req).configId))
    .orderBy(desc(schema.tickets.createdAt))
    .limit(100);
  res.json(rows.map(toTicketDTO));
});

function toConfigDTO(c: typeof schema.ticketConfigs.$inferSelect): TicketConfigDTO {
  return {
    id: c.id,
    guildId: c.guildId.toString(),
    name: c.name,
    buttonLabel: c.buttonLabel,
    buttonEmoji: c.buttonEmoji,
    channelId: c.channelId.toString(),
    categoryId: c.categoryId?.toString() ?? null,
    channelType: c.channelType,
    supportRoleIds: c.supportRoleIds,
    pingRoleIds: c.pingRoleIds,
    welcomeMessage: c.welcomeMessage ?? "",
    ticketNameFormat: c.ticketNameFormat,
    maxOpenPerUser: c.maxOpenPerUser,
    leaveAction: c.leaveAction,
    transcriptOnClose: c.transcriptOnClose,
    transcriptChannelId: c.transcriptChannelId?.toString() ?? null,
    creatorCanClose: c.creatorCanClose,
    claimingEnabled: c.claimingEnabled,
    ratingEnabled: c.ratingEnabled,
    active: c.active,
  };
}

function toTicketDTO(t: typeof schema.tickets.$inferSelect): TicketDTO {
  return {
    id: t.id,
    configId: t.configId,
    openerId: t.openerId.toString(),
    channelId: t.channelId.toString(),
    status: t.status,
    claimedBy: t.claimedBy?.toString() ?? null,
    closedBy: t.closedBy?.toString() ?? null,
    closeReason: t.closeReason,
    transcriptUrl: t.transcriptUrl,
    rating: t.rating,
    ratingComment: t.ratingComment,
    createdAt: t.createdAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}
