// api/src/routes/dedicatedBot.ts
//
// Where a customer supplies the bot token for dedicated hosting.
// Mounted at /api/guilds/:guildId/dedicated-bot
//
// OWNER ONLY, not admin. A bot token is total control of that bot — reading
// every message it can see, acting as it anywhere it is present. Delegating
// "manage the applications" to a staff member should not also hand over the
// ability to swap the identity the whole server runs on. Same reasoning as
// export/import, which is already owner-gated.
//
// THE TOKEN IS WRITE-ONLY.
//
// No route returns it, not even to the owner who set it. Once stored it can be
// replaced or cleared, never read back. Discord shows it once on generation
// for the same reason, and a dashboard that could redisplay it turns one
// compromised session into a permanent credential leak.

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/client.ts";
import { routeParams } from "../utils/routeParams.ts";
import { requireGuildAccess, requireOwnerAccess } from "../middleware/guildAccess.ts";
import { encrypt } from "../utils/crypto.ts";
import { logger } from "../utils/logger.ts";

export const dedicatedBotRouter: Router = Router({ mergeParams: true });

dedicatedBotRouter.use(requireGuildAccess, requireOwnerAccess);

/**
 * Discord bot tokens are three base64url segments separated by dots. Checked
 * loosely on purpose: the format has changed before, and a regex that rejects
 * a valid token is worse than one that accepts a wrong string Discord will
 * reject anyway. This catches the common mistakes — a client secret pasted by
 * mistake, or a token with whitespace around it — not every possible error.
 */
const TOKEN_SHAPE = /^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/;

const bodySchema = z.object({
  token: z.string().trim().min(1),
});

/** Status only. Never the token. */
dedicatedBotRouter.get("/", async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const guild = await db.query.guilds.findFirst({
    where: eq(schema.guilds.id, guildId),
    columns: {
      hostingMode: true,
      customBotStatus: true,
      customBotError: true,
      customBotTokenEnc: true,
      customBotHeartbeatAt: true,
    },
  });
  if (!guild) return res.status(404).json({ error: "guild_not_found" });

  res.json({
    hostingMode: guild.hostingMode,
    // Whether one is set, never what it is.
    tokenSet: Boolean(guild.customBotTokenEnc),
    status: guild.customBotStatus,
    error: guild.customBotError,
    // Lets the dashboard say "running, last seen 20 seconds ago" rather than
    // just "running" — the difference between a live claim and a stale one.
    lastSeenAt: guild.customBotHeartbeatAt?.toISOString() ?? null,
  });
});

dedicatedBotRouter.put("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const token = parsed.data.token;
  const guildId = BigInt(routeParams(req).guildId);

  if (!TOKEN_SHAPE.test(token)) {
    return res.status(422).json({
      error: "invalid_token",
      message:
        "That does not look like a bot token. Copy it from the Discord Developer Portal under " +
        "Bot → Token — not the Client Secret, which is a different value from a different page.",
    });
  }

  const guild = await db.query.guilds.findFirst({
    where: eq(schema.guilds.id, guildId),
    columns: { hostingMode: true },
  });
  if (!guild) return res.status(404).json({ error: "guild_not_found" });

  if (guild.hostingMode !== "custom") {
    // Refused rather than stored-for-later: holding somebody's bot token
    // against a plan they have not bought means holding a credential we have
    // no reason to have.
    return res.status(409).json({
      error: "hosting_not_active",
      message: "Dedicated hosting is not active for this server. Buy it on the billing page first.",
    });
  }

  await db
    .update(schema.guilds)
    .set({
      customBotTokenEnc: encrypt(token),
      // Reset so the runner picks it up on its next scan. Without clearing the
      // claim, a replacement token would sit unused behind a runner still
      // holding the old one until its heartbeat lapsed.
      customBotStatus: "stopped",
      customBotError: null,
      customBotRunnerId: null,
      customBotHeartbeatAt: null,
    })
    .where(eq(schema.guilds.id, guildId));

  // Deliberately no token, no length, no prefix — a log line is the easiest
  // place for a credential to end up somewhere it is never rotated out of.
  logger.info("Dedicated bot token set", { guildId: guildId.toString() });

  res.json({ ok: true, status: "stopped", message: "Token saved. Your bot will connect shortly." });
});

dedicatedBotRouter.delete("/", async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  await db
    .update(schema.guilds)
    .set({
      customBotTokenEnc: null,
      customBotStatus: "stopped",
      customBotError: null,
      customBotRunnerId: null,
      customBotHeartbeatAt: null,
    })
    .where(and(eq(schema.guilds.id, guildId)));

  logger.info("Dedicated bot token cleared", { guildId: guildId.toString() });
  res.json({ ok: true });
});
