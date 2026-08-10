// api/src/routes/antiRaid.ts
// Mounted at /api/guilds/:guildId/anti-raid

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";

export const antiRaidRouter = Router({ mergeParams: true });

const configSchema = z.object({
  enabled: z.boolean().default(false),
  joinThreshold: z.number().int().min(3).max(1000).default(10),
  windowSeconds: z.number().int().min(10).max(3600).default(60),
  action: z.enum(["alert_only", "lock_verification", "kick_new_joins"]).default("alert_only"),
  alertChannelId: z.string().nullable().optional(),
  alertRoleIds: z.array(z.string()).default([]),
  autoLockdownExpiresAfterSeconds: z.number().int().min(60).max(86400).default(1800),
});

antiRaidRouter.use(requireGuildAccess);

antiRaidRouter.get("/", async (req, res) => {
  const config = await db.query.antiRaidConfigs.findFirst({ where: eq(schema.antiRaidConfigs.guildId, BigInt(req.params.guildId)) });
  res.json(config ? toDTO(config) : null);
});

antiRaidRouter.put("/", requireAdminAccess, async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(req.params.guildId);

  const values = {
    guildId,
    enabled: data.enabled,
    joinThreshold: data.joinThreshold,
    windowSeconds: data.windowSeconds,
    action: data.action,
    alertChannelId: data.alertChannelId ? BigInt(data.alertChannelId) : null,
    alertRoleIds: data.alertRoleIds,
    autoLockdownExpiresAfterSeconds: data.autoLockdownExpiresAfterSeconds,
  };

  const [upserted] = await db
    .insert(schema.antiRaidConfigs)
    .values(values)
    .onConflictDoUpdate({ target: schema.antiRaidConfigs.guildId, set: { ...values, updatedAt: new Date() } })
    .returning();

  res.json(toDTO(upserted));
});

// Lockdown status + manual clear, mirroring /anti-raid clear on the bot
// side — useful for a dashboard "panic button" that doesn't require
// finding a staff member with Discord access at that moment.
antiRaidRouter.get("/lockdown", async (req, res) => {
  const lockdown = await db.query.raidLockdowns.findFirst({ where: eq(schema.raidLockdowns.guildId, BigInt(req.params.guildId)) });
  if (!lockdown) return res.json({ active: false });
  res.json({
    active: lockdown.expiresAt > new Date(),
    triggeredAt: lockdown.triggeredAt.toISOString(),
    triggeredByJoinCount: lockdown.triggeredByJoinCount,
    expiresAt: lockdown.expiresAt.toISOString(),
  });
});

antiRaidRouter.post("/lockdown/clear", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const [updated] = await db
    .update(schema.raidLockdowns)
    .set({ expiresAt: new Date(), clearedBy: req.userId! })
    .where(eq(schema.raidLockdowns.guildId, guildId))
    .returning();
  res.json({ cleared: Boolean(updated) });
});

function toDTO(c: typeof schema.antiRaidConfigs.$inferSelect) {
  return {
    guildId: c.guildId.toString(),
    enabled: c.enabled,
    joinThreshold: c.joinThreshold,
    windowSeconds: c.windowSeconds,
    action: c.action,
    alertChannelId: c.alertChannelId?.toString() ?? null,
    alertRoleIds: c.alertRoleIds,
    autoLockdownExpiresAfterSeconds: c.autoLockdownExpiresAfterSeconds,
  };
}
