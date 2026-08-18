// api/src/routes/giveaways.ts
// Mounted at /api/guilds/:guildId/giveaways

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { countRows } from "../db/count.ts";
import { requireGuildAccess, requireAdminAccess } from "../middleware/guildAccess.ts";
import { requestGiveawayPublish, requestGiveawayEnd, requestGiveawayReroll } from "../services/botBridge.ts";
import type { GiveawayDTO } from "../../../shared/types/index.ts";

export const giveawaysRouter = Router({ mergeParams: true });

const giveawaySchema = z.object({
  channelId: z.string(),
  prize: z.string().min(1).max(256),
  winnerCount: z.number().int().min(1).max(50).default(1),
  requiredRoleIds: z.array(z.string()).default([]),
  blacklistedRoleIds: z.array(z.string()).default([]),
  bonusRoleEntries: z.array(z.object({ roleId: z.string(), extraEntries: z.number().int().min(1).max(50) })).default([]),
  endsAt: z.string().datetime(),
});

giveawaysRouter.use(requireGuildAccess);

giveawaysRouter.get("/", async (req, res) => {
  const rows = await db.select().from(schema.giveaways).where(eq(schema.giveaways.guildId, BigInt(routeParams(req).guildId)));
  const withCounts = await Promise.all(
    rows.map(async (g) => ({
      ...g,
      entryCount: await countRows(schema.giveawayEntries, eq(schema.giveawayEntries.giveawayId, g.id)),
    })),
  );
  res.json(withCounts.map(toDTO));
});

giveawaysRouter.post("/", requireAdminAccess, async (req, res) => {
  const parsed = giveawaySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const data = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const [created] = await db
    .insert(schema.giveaways)
    .values({
      guildId,
      channelId: BigInt(data.channelId),
      prize: data.prize,
      winnerCount: data.winnerCount,
      requiredRoleIds: data.requiredRoleIds,
      blacklistedRoleIds: data.blacklistedRoleIds,
      bonusRoleEntries: data.bonusRoleEntries,
      endsAt: new Date(data.endsAt),
      hostId: req.userId!,
      status: "draft",
    })
    .returning();

  res.status(201).json(toDTO({ ...created, entryCount: 0 }));
});

giveawaysRouter.post("/:giveawayId/publish", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const giveaway = await db.query.giveaways.findFirst({
    where: and(eq(schema.giveaways.id, routeParams(req).giveawayId), eq(schema.giveaways.guildId, guildId)),
  });
  if (!giveaway) return res.status(404).json({ error: "giveaway_not_found" });
  if (giveaway.status !== "draft") return res.status(409).json({ error: "already_published" });

  try {
    await requestGiveawayPublish(giveaway.id);
  } catch (err) {
    return res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
  res.status(202).json({ status: "publish_requested" });
});

giveawaysRouter.post("/:giveawayId/end", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const giveaway = await db.query.giveaways.findFirst({
    where: and(eq(schema.giveaways.id, routeParams(req).giveawayId), eq(schema.giveaways.guildId, guildId)),
  });
  if (!giveaway) return res.status(404).json({ error: "giveaway_not_found" });
  if (giveaway.status !== "running") return res.status(409).json({ error: "not_running" });

  try {
    const result = await requestGiveawayEnd(giveaway.id);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
});

giveawaysRouter.post("/:giveawayId/reroll", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const giveaway = await db.query.giveaways.findFirst({
    where: and(eq(schema.giveaways.id, routeParams(req).giveawayId), eq(schema.giveaways.guildId, guildId)),
  });
  if (!giveaway) return res.status(404).json({ error: "giveaway_not_found" });
  if (giveaway.status !== "ended") return res.status(409).json({ error: "not_ended" });

  try {
    const result = await requestGiveawayReroll(giveaway.id);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
});

giveawaysRouter.delete("/:giveawayId", requireAdminAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const result = await db
    .delete(schema.giveaways)
    .where(and(eq(schema.giveaways.id, routeParams(req).giveawayId), eq(schema.giveaways.guildId, guildId)))
    .returning();
  if (result.length === 0) return res.status(404).json({ error: "giveaway_not_found" });
  res.status(204).send();
});

function toDTO(g: typeof schema.giveaways.$inferSelect & { entryCount: number }): GiveawayDTO {
  return {
    id: g.id,
    guildId: g.guildId.toString(),
    channelId: g.channelId.toString(),
    messageId: g.messageId?.toString() ?? null,
    prize: g.prize,
    winnerCount: g.winnerCount,
    requiredRoleIds: g.requiredRoleIds,
    blacklistedRoleIds: g.blacklistedRoleIds,
    bonusRoleEntries: g.bonusRoleEntries,
    status: g.status,
    scheduledFor: g.scheduledFor?.toISOString() ?? null,
    endsAt: g.endsAt?.toISOString() ?? null,
    endedAt: g.endedAt?.toISOString() ?? null,
    winnerIds: g.winnerIds,
    entryCount: g.entryCount,
  };
}
