// api/src/routes/roleMenus.ts
// Mounted at /api/guilds/:guildId/role-menus

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { requestRoleMenuPublish } from "../services/botBridge.ts";

export const roleMenusRouter = Router({ mergeParams: true });

const optionSchema = z.object({
  roleId: z.string(),
  label: z.string().min(1).max(100),
  emoji: z.string().nullable().optional(),
  description: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().default(0),
});

const menuSchema = z.object({
  channelId: z.string(),
  title: z.string().min(1).max(256).default("Choose your roles"),
  description: z.string().max(2000).default(""),
  selectionMode: z.enum(["single", "multi"]).default("multi"),
  options: z.array(optionSchema).min(1).max(25),
});

roleMenusRouter.use(requireGuildAccess);

roleMenusRouter.get("/", async (req, res) => {
  const menus = await db.query.roleMenus.findMany({
    where: eq(schema.roleMenus.guildId, BigInt(req.params.guildId)),
    with: { options: { orderBy: (o, { asc }) => [asc(o.sortOrder)] } },
  });
  res.json(menus.map(toDTO));
});

roleMenusRouter.post("/", requireAdminAccess, async (req, res) => {
  const parsed = menuSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(req.params.guildId);

  const menu = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.roleMenus)
      .values({
        guildId,
        channelId: BigInt(data.channelId),
        title: data.title,
        description: data.description,
        selectionMode: data.selectionMode,
      })
      .returning();

    await tx.insert(schema.roleMenuOptions).values(
      data.options.map((o) => ({
        menuId: created.id,
        roleId: BigInt(o.roleId),
        label: o.label,
        emoji: o.emoji ?? null,
        description: o.description ?? null,
        sortOrder: o.sortOrder,
      })),
    );
    return created;
  });

  const full = await db.query.roleMenus.findFirst({ where: eq(schema.roleMenus.id, menu.id), with: { options: true } });
  res.status(201).json(toDTO(full!));
});

roleMenusRouter.patch("/:menuId", requireAdminAccess, async (req, res) => {
  const parsed = menuSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(req.params.guildId);
  const menuId = req.params.menuId;

  const existing = await db.query.roleMenus.findFirst({
    where: and(eq(schema.roleMenus.id, menuId), eq(schema.roleMenus.guildId, guildId)),
  });
  if (!existing) return res.status(404).json({ error: "menu_not_found" });

  await db.transaction(async (tx) => {
    const updateSet: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) updateSet.title = data.title;
    if (data.description !== undefined) updateSet.description = data.description;
    if (data.selectionMode !== undefined) updateSet.selectionMode = data.selectionMode;
    if (data.channelId !== undefined) updateSet.channelId = BigInt(data.channelId);
    await tx.update(schema.roleMenus).set(updateSet).where(eq(schema.roleMenus.id, menuId));

    if (data.options !== undefined) {
      await tx.delete(schema.roleMenuOptions).where(eq(schema.roleMenuOptions.menuId, menuId));
      await tx.insert(schema.roleMenuOptions).values(
        data.options.map((o) => ({
          menuId,
          roleId: BigInt(o.roleId),
          label: o.label,
          emoji: o.emoji ?? null,
          description: o.description ?? null,
          sortOrder: o.sortOrder,
        })),
      );
    }
  });

  const refreshed = await db.query.roleMenus.findFirst({ where: eq(schema.roleMenus.id, menuId), with: { options: true } });
  if (refreshed?.published) {
    await requestRoleMenuPublish(menuId).catch(() => {});
  }
  res.json(toDTO(refreshed!));
});

roleMenusRouter.post("/:menuId/publish", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const menu = await db.query.roleMenus.findFirst({
    where: and(eq(schema.roleMenus.id, req.params.menuId), eq(schema.roleMenus.guildId, guildId)),
  });
  if (!menu) return res.status(404).json({ error: "menu_not_found" });

  try {
    await requestRoleMenuPublish(menu.id);
  } catch (err) {
    return res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
  res.status(202).json({ status: "publish_requested" });
});

roleMenusRouter.delete("/:menuId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const result = await db
    .delete(schema.roleMenus)
    .where(and(eq(schema.roleMenus.id, req.params.menuId), eq(schema.roleMenus.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "menu_not_found" });
  res.status(204).send();
});

function toDTO(menu: typeof schema.roleMenus.$inferSelect & { options: (typeof schema.roleMenuOptions.$inferSelect)[] }) {
  return {
    id: menu.id,
    guildId: menu.guildId.toString(),
    channelId: menu.channelId.toString(),
    messageId: menu.messageId?.toString() ?? null,
    title: menu.title,
    description: menu.description ?? "",
    selectionMode: menu.selectionMode,
    published: menu.published,
    options: menu.options.map((o) => ({
      id: o.id,
      roleId: o.roleId.toString(),
      label: o.label,
      emoji: o.emoji,
      description: o.description,
      sortOrder: o.sortOrder,
    })),
  };
}
