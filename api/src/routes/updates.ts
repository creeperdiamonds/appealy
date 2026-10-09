// api/src/routes/updates.ts
//
// Appealy's updates, in each server. On the hosted platform every server picks
// one of its channels to receive Appealy's changelogs and announcements. The
// bot makes that channel follow Appealy's announcement channel through
// Discord's own Follow, so updates arrive without anyone joining Appealy's
// server and without Appealy posting anything itself.
//
// Optional until UPDATES_REQUIRED_FROM; after that, the dashboard is locked
// until a channel is picked (web/src/components/UpdatesRequirement.tsx).
// Only the dashboard: applications, appeals and tickets keep working, so no
// member is punished for a setting only an admin can change. Self-hosted
// deployments are never asked.
//
// Mounted at /api/guilds/:guildId/updates.

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { routeParams } from "../utils/routeParams.ts";
import { db, schema } from "../db/client.ts";
import { deployment } from "../env.ts";
import { requireAdminAccess, requireGuildAccess } from "../middleware/guildAccess.ts";
import { botCallFailure, requestUpdatesFollow, requestUpdatesVerify } from "../services/botBridge.ts";
import { logger } from "../utils/logger.ts";

/** Appealy's announcement channel, which servers follow. */
const SOURCE_CHANNEL_ID = process.env.APPEALY_UPDATES_CHANNEL_ID ?? "1511370279312429097";
/** When picking a channel stops being optional. Announced on the dashboard until then. */
const REQUIRED_FROM = new Date(process.env.UPDATES_REQUIRED_FROM ?? "2026-10-17T00:00:00Z");

export const updatesRouter = Router({ mergeParams: true });
updatesRouter.use(requireGuildAccess);

updatesRouter.get("/", async (req, res) => {
  const asked = deployment.mode === "platform";
  const guildId = BigInt(routeParams(req).guildId);
  let row = await db.query.updateSubscriptions.findFirst({ where: eq(schema.updateSubscriptions.guildId, guildId) });

  // Someone may have removed the follow in Discord. Checked here because this
  // is what decides whether the dashboard opens; a bot that can't answer
  // right now is not proof of anything, so the row stands.
  if (row && asked) {
    try {
      const { exists } = await requestUpdatesVerify(row.webhookId.toString());
      if (!exists) {
        await db.delete(schema.updateSubscriptions).where(eq(schema.updateSubscriptions.guildId, guildId));
        row = undefined;
      }
    } catch {
      // keep it
    }
  }

  res.json({
    asked,
    requiredFrom: REQUIRED_FROM.toISOString(),
    required: asked && Date.now() >= REQUIRED_FROM.getTime(),
    following: row ? { channelId: row.channelId.toString(), since: row.followedAt.toISOString() } : null,
  });
});

updatesRouter.put("/", requireAdminAccess, async (req, res) => {
  const parsed = z.object({ channelId: z.string().regex(/^\d{17,20}$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body" });
  const guildId = BigInt(routeParams(req).guildId);

  let webhookId: string;
  try {
    ({ webhookId } = await requestUpdatesFollow(SOURCE_CHANNEL_ID, parsed.data.channelId));
  } catch (err) {
    logger.warn("Couldn't follow Appealy's updates", { guildId: guildId.toString(), error: String(err) });
    return res.status(502).json(botCallFailure(err));
  }

  const values = { channelId: BigInt(parsed.data.channelId), webhookId: BigInt(webhookId), followedAt: new Date() };
  await db
    .insert(schema.updateSubscriptions)
    .values({ guildId, ...values })
    .onConflictDoUpdate({ target: schema.updateSubscriptions.guildId, set: values });
  res.json({ following: { channelId: parsed.data.channelId, since: values.followedAt.toISOString() } });
});
