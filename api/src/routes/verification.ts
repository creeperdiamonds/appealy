// api/src/routes/verification.ts
// Single-row-per-guild verification config. Mounted at /api/guilds/:guildId/verification

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { requestVerificationPublish } from "../services/botBridge.ts";
import type { VerificationConfigDTO } from "../../../shared/types/index.ts";

export const verificationRouter = Router({ mergeParams: true });

const configSchema = z.object({
  enabled: z.boolean().default(false),
  channelId: z.string().nullable().optional(),
  method: z.enum(["button", "captcha"]).default("button"),
  verifiedRoleId: z.string().nullable().optional(),
  unverifiedRoleId: z.string().nullable().optional(),
  panelTitle: z.string().max(256).default("Verification"),
  panelDescription: z.string().max(2000).default("Click the button below to verify and gain access to the server."),
  kickUnverifiedAfterSeconds: z.number().int().min(60).nullable().optional(),
});

verificationRouter.use(requireGuildAccess);

verificationRouter.get("/", async (req, res) => {
  const config = await db.query.verificationConfigs.findFirst({ where: eq(schema.verificationConfigs.guildId, BigInt(routeParams(req).guildId)) });
  res.json(config ? toDTO(config) : null);
});

verificationRouter.put("/", requireAdminAccess, async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const [upserted] = await db
    .insert(schema.verificationConfigs)
    .values({
      guildId,
      enabled: data.enabled,
      channelId: data.channelId ? BigInt(data.channelId) : null,
      method: data.method,
      verifiedRoleId: data.verifiedRoleId ? BigInt(data.verifiedRoleId) : null,
      unverifiedRoleId: data.unverifiedRoleId ? BigInt(data.unverifiedRoleId) : null,
      panelTitle: data.panelTitle,
      panelDescription: data.panelDescription,
      kickUnverifiedAfterSeconds: data.kickUnverifiedAfterSeconds ?? null,
    })
    .onConflictDoUpdate({
      target: schema.verificationConfigs.guildId,
      set: {
        enabled: data.enabled,
        channelId: data.channelId ? BigInt(data.channelId) : null,
        method: data.method,
        verifiedRoleId: data.verifiedRoleId ? BigInt(data.verifiedRoleId) : null,
        unverifiedRoleId: data.unverifiedRoleId ? BigInt(data.unverifiedRoleId) : null,
        panelTitle: data.panelTitle,
        panelDescription: data.panelDescription,
        kickUnverifiedAfterSeconds: data.kickUnverifiedAfterSeconds ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json(toDTO(upserted));
});

verificationRouter.post("/publish", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const config = await db.query.verificationConfigs.findFirst({ where: eq(schema.verificationConfigs.guildId, guildId) });
  if (!config || !config.channelId) return res.status(400).json({ error: "channel_not_configured" });

  try {
    await requestVerificationPublish(guildId.toString());
  } catch (err) {
    return res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
  res.status(202).json({ status: "publish_requested" });
});

function toDTO(c: typeof schema.verificationConfigs.$inferSelect): VerificationConfigDTO {
  return {
    guildId: c.guildId.toString(),
    enabled: c.enabled,
    channelId: c.channelId?.toString() ?? null,
    messageId: c.messageId?.toString() ?? null,
    method: c.method,
    verifiedRoleId: c.verifiedRoleId?.toString() ?? null,
    unverifiedRoleId: c.unverifiedRoleId?.toString() ?? null,
    panelTitle: c.panelTitle,
    panelDescription: c.panelDescription ?? "",
    kickUnverifiedAfterSeconds: c.kickUnverifiedAfterSeconds,
  };
}
