// api/src/routes/tickets.ts
// Ticket type (config) CRUD + read-only ticket history.
// Mounted at /api/guilds/:guildId/ticket-configs

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { requestTicketPanelPublish, botCallFailure } from "../services/botBridge.ts";
import {
  MAX_TICKET_CATEGORIES,
  MAX_TICKET_QUESTIONS,
  type TicketConfigDTO,
  type TicketDTO,
} from "../../../shared/types/index.ts";
import { parseEmoji } from "../../../shared/lib/emoji.ts";
import { discordId, discordIdList, discordIdOrBlank } from "../utils/discordIds.ts";

export const ticketsRouter = Router({ mergeParams: true });

// Same check as the type's own button emoji, for the same reason.
const emojiField = z
  .string()
  .nullable()
  .optional()
  .superRefine((value, ctx) => {
    if (value == null) return;
    const parsed = parseEmoji(value);
    if (!parsed.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.message });
  });

const categorySchema = z.object({
  // Present for a category that already exists, so saving edits it in place
  // rather than replacing it (which would detach its open tickets).
  id: z.string().max(64).optional(),
  label: z.string().min(1).max(80),
  emoji: emojiField,
  description: z.string().max(100).nullable().optional(),
  discordCategoryId: discordIdOrBlank.nullable().optional(),
  supportRoleIds: discordIdList.default([]),
  pingRoleIds: discordIdList.default([]),
  welcomeMessage: z.string().max(1000).nullable().optional(),
  questions: z
    .array(
      z.object({
        label: z.string().min(1).max(45),
        paragraph: z.boolean().default(false),
        required: z.boolean().default(true),
      }),
    )
    .max(MAX_TICKET_QUESTIONS)
    .default([]),
});

const configSchema = z.object({
  // The whole list, in panel order. Absent on a PATCH = leave them alone.
  categories: z.array(categorySchema).max(MAX_TICKET_CATEGORIES).optional(),
  name: z.string().min(1).max(100),
  buttonLabel: z.string().min(1).max(80).default("Open Ticket"),
  // Validated here rather than left to fail at publish time. A shortcode like
  // :ticket: saves fine, publishes fine, and renders as nothing — so the only
  // signal anyone got was a button that looked wrong, with no way to tell
  // whether the emoji, the panel or the bot was at fault.
  buttonEmoji: z
    .string()
    .nullable()
    .optional()
    .superRefine((value, ctx) => {
      if (value == null) return;
      const parsed = parseEmoji(value);
      if (!parsed.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.message });
      }
    }),
  channelId: discordId,
  categoryId: discordIdOrBlank.nullable().optional(),
  channelType: z.enum(["private_channel", "private_thread", "public_thread"]).default("private_channel"),
  supportRoleIds: discordIdList.default([]),
  pingRoleIds: discordIdList.default([]),
  panelMessage: z.string().max(1000).default("Click below to open a ticket."),
  welcomeMessage: z.string().max(1000).default("Thanks for opening a ticket. A member of staff will be with you shortly."),
  ticketNameFormat: z.string().max(100).default("ticket-{username}"),
  maxOpenPerUser: z.number().int().min(1).max(10).default(1),
  leaveAction: z.enum(["none", "close", "notify"]).default("none"),
  transcriptOnClose: z.boolean().default(true),
  transcriptChannelId: discordIdOrBlank.nullable().optional(),
  creatorCanClose: z.boolean().default(true),
  claimingEnabled: z.boolean().default(false),
  ratingEnabled: z.boolean().default(false),
  active: z.boolean().default(true),
});

ticketsRouter.use(requireGuildAccess);

type CategoryInput = z.infer<typeof categorySchema>;
type ConfigWithCategories = typeof schema.ticketConfigs.$inferSelect & {
  categories: (typeof schema.ticketCategories.$inferSelect)[];
};

async function loadConfig(configId: string): Promise<ConfigWithCategories> {
  const row = await db.query.ticketConfigs.findFirst({
    where: eq(schema.ticketConfigs.id, configId),
    with: { categories: { orderBy: (c, { asc }) => [asc(c.sortOrder), asc(c.createdAt)] } },
  });
  return row!;
}

/**
 * Makes the stored categories match the list the dashboard sent: known ids are
 * updated in place (their open tickets stay attached), new ones inserted,
 * omitted ones deleted. A client-supplied id that isn't this config's is
 * treated as new rather than trusted.
 */
async function syncCategories(configId: string, incoming: CategoryInput[]) {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: schema.ticketCategories.id })
      .from(schema.ticketCategories)
      .where(eq(schema.ticketCategories.configId, configId));
    const known = new Set(existing.map((e) => e.id));
    const keep = new Set<string>();

    for (const [index, c] of incoming.entries()) {
      const values = {
        label: c.label.trim(),
        emoji: c.emoji ?? null,
        description: c.description?.trim() || null,
        discordCategoryId: c.discordCategoryId ? BigInt(c.discordCategoryId) : null,
        supportRoleIds: c.supportRoleIds,
        pingRoleIds: c.pingRoleIds,
        welcomeMessage: c.welcomeMessage?.trim() || null,
        questions: c.questions.map((q) => ({ ...q, label: q.label.trim() })),
        sortOrder: index,
      };
      if (c.id && known.has(c.id) && !keep.has(c.id)) {
        keep.add(c.id);
        await tx.update(schema.ticketCategories).set(values).where(eq(schema.ticketCategories.id, c.id));
      } else {
        const [row] = await tx.insert(schema.ticketCategories).values({ configId, ...values }).returning({ id: schema.ticketCategories.id });
        keep.add(row.id);
      }
    }

    for (const id of known) {
      if (!keep.has(id)) await tx.delete(schema.ticketCategories).where(eq(schema.ticketCategories.id, id));
    }
  });
}

ticketsRouter.get("/", async (req, res) => {
  const configs = await db.query.ticketConfigs.findMany({
    where: eq(schema.ticketConfigs.guildId, BigInt(routeParams(req).guildId)),
    with: { categories: { orderBy: (c, { asc }) => [asc(c.sortOrder), asc(c.createdAt)] } },
  });
  res.json(configs.map(toConfigDTO));
});


// transcriptOnClose is "Keep closed tickets" and transcriptChannelId the log
// channel since 2026-11-10, when transcripts went with the Message Content
// intent. A log channel is optional: a kept ticket is its own record.

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
      panelMessage: data.panelMessage,
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

  if (data.categories?.length) await syncCategories(created.id, data.categories);

  res.status(201).json(toConfigDTO(await loadConfig(created.id)));
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
    "panelMessage",
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

  await db.update(schema.ticketConfigs).set(updateSet).where(eq(schema.ticketConfigs.id, configId));
  if (data.categories !== undefined) await syncCategories(configId, data.categories);
  res.json(toConfigDTO(await loadConfig(configId)));
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
    return res.status(502).json(botCallFailure(err));
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

function toConfigDTO(c: ConfigWithCategories): TicketConfigDTO {
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
    panelMessage: c.panelMessage ?? "",
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
    categories: c.categories.map((k) => ({
      id: k.id,
      label: k.label,
      emoji: k.emoji,
      description: k.description,
      discordCategoryId: k.discordCategoryId?.toString() ?? null,
      supportRoleIds: k.supportRoleIds,
      pingRoleIds: k.pingRoleIds,
      welcomeMessage: k.welcomeMessage,
      questions: k.questions,
    })),
  };
}

function toTicketDTO(t: typeof schema.tickets.$inferSelect): TicketDTO {
  return {
    id: t.id,
    configId: t.configId,
    ticketCategoryId: t.ticketCategoryId,
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
