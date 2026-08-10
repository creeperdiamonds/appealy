// api/src/routes/welcomer.ts
// Single-row-per-guild welcomer config. Mounted at /api/guilds/:guildId/welcomer

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import type { WelcomerConfigDTO } from "../../../shared/types/index.ts";

export const welcomerRouter = Router({ mergeParams: true });

const configSchema = z.object({
  joinEnabled: z.boolean().default(false),
  joinChannelId: z.string().nullable().optional(),
  joinMessage: z.string().max(2000).default("Welcome to {guild}, {username}! You are member #{membercount}."),
  joinDmEnabled: z.boolean().default(false),
  joinDmMessage: z.string().max(2000).nullable().optional(),
  joinEmbedColor: z.number().int().default(0x5865f2),
  joinImageUrl: z.string().url().nullable().optional(),
  autoRoleIds: z.array(z.string()).default([]),
  leaveEnabled: z.boolean().default(false),
  leaveChannelId: z.string().nullable().optional(),
  leaveMessage: z.string().max(2000).default("{username} has left {guild}."),
});

welcomerRouter.use(requireGuildAccess);

welcomerRouter.get("/", async (req, res) => {
  const config = await db.query.welcomerConfigs.findFirst({ where: eq(schema.welcomerConfigs.guildId, BigInt(req.params.guildId)) });
  res.json(config ? toDTO(config) : null);
});

welcomerRouter.put("/", requireAdminAccess, async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(req.params.guildId);

  const values = {
    guildId,
    joinEnabled: data.joinEnabled,
    joinChannelId: data.joinChannelId ? BigInt(data.joinChannelId) : null,
    joinMessage: data.joinMessage,
    joinDmEnabled: data.joinDmEnabled,
    joinDmMessage: data.joinDmMessage ?? null,
    joinEmbedColor: data.joinEmbedColor,
    joinImageUrl: data.joinImageUrl ?? null,
    autoRoleIds: data.autoRoleIds,
    leaveEnabled: data.leaveEnabled,
    leaveChannelId: data.leaveChannelId ? BigInt(data.leaveChannelId) : null,
    leaveMessage: data.leaveMessage,
  };

  const [upserted] = await db
    .insert(schema.welcomerConfigs)
    .values(values)
    .onConflictDoUpdate({
      target: schema.welcomerConfigs.guildId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();

  res.json(toDTO(upserted));
});

function toDTO(c: typeof schema.welcomerConfigs.$inferSelect): WelcomerConfigDTO {
  return {
    guildId: c.guildId.toString(),
    joinEnabled: c.joinEnabled,
    joinChannelId: c.joinChannelId?.toString() ?? null,
    joinMessage: c.joinMessage ?? "",
    joinDmEnabled: c.joinDmEnabled,
    joinDmMessage: c.joinDmMessage,
    joinEmbedColor: c.joinEmbedColor ?? 0x5865f2,
    joinImageUrl: c.joinImageUrl,
    autoRoleIds: c.autoRoleIds,
    leaveEnabled: c.leaveEnabled,
    leaveChannelId: c.leaveChannelId?.toString() ?? null,
    leaveMessage: c.leaveMessage ?? "",
  };
}
