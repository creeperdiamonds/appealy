// api/src/routes/panels.ts
// CRUD for panels + their attached form buttons. Mounted at /api/guilds/:guildId/panels
// Publishing (sending/updating the actual Discord message) is delegated to
// the bot process via an internal RPC call rather than done here, since
// only the bot holds a live gateway/REST session — see services/botBridge.ts

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { requestPanelPublish, requestPanelSync } from "../services/botBridge.ts";
import { checkStandingCap } from "../services/rateLimitService.ts";
import type { PanelDTO } from "../../../shared/types/index.ts";

export const panelsRouter = Router({ mergeParams: true });

const buttonSchema = z.object({
  formId: z.string(),
  label: z.string().min(1).max(80),
  emoji: z.string().nullable().optional(),
  style: z.enum(["primary", "secondary", "success", "danger"]).default("primary"),
  sortOrder: z.number().int().default(0),
});

const panelSchema = z.object({
  channelId: z.string(),
  title: z.string().min(1).max(256),
  description: z.string().max(2000).default(""),
  color: z.number().int().default(0x5865f2),
  imageUrl: z.string().url().nullable().optional(),
  thumbnailUrl: z.string().url().nullable().optional(),
  footerText: z.string().max(256).nullable().optional(),
  // Available to every guild regardless of billing tier — display style is
  // a feature choice, not throughput, and this project only charges for
  // throughput (see shared/schema/pricing.ts) and optional dedicated hosting.
  displayType: z.enum(["buttons", "dropdown"]).default("buttons"),
  buttons: z.array(buttonSchema).min(1).max(5), // Discord caps 5 buttons per action row, and dropdown mode caps 25 select options
});

panelsRouter.use(requireGuildAccess);

panelsRouter.get("/", async (req, res) => {
  const panels = await db.query.panels.findMany({
    where: eq(schema.panels.guildId, BigInt(req.params.guildId)),
    with: { buttons: { orderBy: (b, { asc }) => [asc(b.sortOrder)] } },
  });
  res.json(panels.map(toDTO));
});

panelsRouter.post("/", requireAdminAccess, async (req, res) => {
  const parsed = panelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(req.params.guildId);

  const existingPanelCount = await db.$count(schema.panels, eq(schema.panels.guildId, guildId));
  const capCheck = await checkStandingCap(guildId, "panelsPerGuild", existingPanelCount);
  if (!capCheck.allowed) {
    return res.status(429).json({
      error: "rate_limit_exceeded",
      detail: `This server has reached its limit of ${capCheck.limit} panels. Raise your limit from the billing page, or delete an existing panel first.`,
      current: capCheck.current,
      limit: capCheck.limit,
    });
  }

  const panel = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.panels)
      .values({
        guildId,
        channelId: BigInt(data.channelId),
        title: data.title,
        description: data.description,
        color: data.color,
        imageUrl: data.imageUrl ?? null,
        thumbnailUrl: data.thumbnailUrl ?? null,
        footerText: data.footerText ?? null,
        displayType: data.displayType,
        published: false,
      })
      .returning();

    await tx.insert(schema.panelButtons).values(
      data.buttons.map((b) => ({
        panelId: created.id,
        formId: b.formId,
        label: b.label,
        emoji: b.emoji ?? null,
        style: b.style,
        sortOrder: b.sortOrder,
      })),
    );
    return created;
  });

  const full = await db.query.panels.findFirst({
    where: eq(schema.panels.id, panel.id),
    with: { buttons: true },
  });
  res.status(201).json(toDTO(full!));
});

panelsRouter.patch("/:panelId", requireAdminAccess, async (req, res) => {
  const parsed = panelSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(req.params.guildId);
  const panelId = req.params.panelId;

  const existing = await db.query.panels.findFirst({
    where: and(eq(schema.panels.id, panelId), eq(schema.panels.guildId, guildId)),
  });
  if (!existing) return res.status(404).json({ error: "panel_not_found" });

  await db.transaction(async (tx) => {
    const updateSet: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) updateSet.title = data.title;
    if (data.description !== undefined) updateSet.description = data.description;
    if (data.color !== undefined) updateSet.color = data.color;
    if (data.imageUrl !== undefined) updateSet.imageUrl = data.imageUrl;
    if (data.thumbnailUrl !== undefined) updateSet.thumbnailUrl = data.thumbnailUrl;
    if (data.footerText !== undefined) updateSet.footerText = data.footerText;
    if (data.displayType !== undefined) updateSet.displayType = data.displayType;
    if (data.channelId !== undefined) updateSet.channelId = BigInt(data.channelId);
    await tx.update(schema.panels).set(updateSet).where(eq(schema.panels.id, panelId));

    if (data.buttons !== undefined) {
      await tx.delete(schema.panelButtons).where(eq(schema.panelButtons.panelId, panelId));
      await tx.insert(schema.panelButtons).values(
        data.buttons.map((b) => ({
          panelId,
          formId: b.formId,
          label: b.label,
          emoji: b.emoji ?? null,
          style: b.style,
          sortOrder: b.sortOrder,
        })),
      );
    }
  });

  // If the panel was already live in Discord, push the edit immediately
  // rather than waiting for an explicit re-publish.
  const refreshed = await db.query.panels.findFirst({
    where: eq(schema.panels.id, panelId),
    with: { buttons: true },
  });
  if (refreshed?.published) {
    await requestPanelSync(panelId).catch(() => {
      /* logged inside botBridge; edit still succeeds in DB */
    });
  }

  res.json(toDTO(refreshed!));
});

panelsRouter.post("/:panelId/publish", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const panel = await db.query.panels.findFirst({
    where: and(eq(schema.panels.id, req.params.panelId), eq(schema.panels.guildId, guildId)),
  });
  if (!panel) return res.status(404).json({ error: "panel_not_found" });

  try {
    await requestPanelPublish(panel.id);
  } catch (err) {
    return res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
  res.status(202).json({ status: "publish_requested" });
});

panelsRouter.delete("/:panelId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const result = await db
    .delete(schema.panels)
    .where(and(eq(schema.panels.id, req.params.panelId), eq(schema.panels.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "panel_not_found" });
  res.status(204).send();
});

function toDTO(
  panel: typeof schema.panels.$inferSelect & { buttons: (typeof schema.panelButtons.$inferSelect)[] },
): PanelDTO {
  return {
    id: panel.id,
    guildId: panel.guildId.toString(),
    channelId: panel.channelId.toString(),
    messageId: panel.messageId?.toString() ?? null,
    title: panel.title,
    description: panel.description ?? "",
    color: panel.color ?? 0x5865f2,
    imageUrl: panel.imageUrl,
    thumbnailUrl: panel.thumbnailUrl,
    footerText: panel.footerText,
    displayType: panel.displayType as "buttons" | "dropdown",
    published: panel.published,
    buttons: panel.buttons.map((b) => ({
      id: b.id,
      formId: b.formId,
      label: b.label,
      emoji: b.emoji,
      style: b.style as "primary" | "secondary" | "success" | "danger",
      sortOrder: b.sortOrder,
    })),
  };
}
