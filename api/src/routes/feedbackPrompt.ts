// api/src/routes/feedbackPrompt.ts
// Whether Appealy may ask this server's moderators for feedback on their
// private Accept/Deny confirmation (bot/src/services/feedbackAsk.ts).
// Mounted at /api/guilds/:guildId/feedback-prompt. No row means on.

import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { routeParams } from "../utils/routeParams.ts";
import { db, schema } from "../db/client.ts";
import { requireAdminAccess, requireGuildAccess } from "../middleware/guildAccess.ts";

export const feedbackPromptRouter = Router({ mergeParams: true });

feedbackPromptRouter.use(requireGuildAccess);

feedbackPromptRouter.get("/", async (req, res) => {
  const row = await db.query.feedbackPromptSettings.findFirst({
    where: eq(schema.feedbackPromptSettings.guildId, BigInt(routeParams(req).guildId)),
  });
  res.json({ enabled: row?.enabled ?? true });
});

feedbackPromptRouter.put("/", requireAdminAccess, async (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const guildId = BigInt(routeParams(req).guildId);
  await db
    .insert(schema.feedbackPromptSettings)
    .values({ guildId, enabled: parsed.data.enabled })
    .onConflictDoUpdate({
      target: schema.feedbackPromptSettings.guildId,
      set: { enabled: parsed.data.enabled, updatedAt: new Date() },
    });
  res.json({ enabled: parsed.data.enabled });
});
