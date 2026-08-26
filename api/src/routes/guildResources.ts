// api/src/routes/guildResources.ts
//
// The dashboard's form/panel builder needs live lists of the guild's
// channels and roles for pickers (log channel select, grant-role select,
// etc). This data is only available via the bot's REST session (using the
// bot token, which the API process never holds directly), so it's proxied
// through the same internal control-server pattern as botBridge.ts.
// Mounted at /api/guilds/:guildId/resources

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { requireGuildAccess } from "../middleware/guildAccess.ts";

export const guildResourcesRouter = Router({ mergeParams: true });

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL ?? "http://bot:9090";
const INTERNAL_SECRET = process.env.INTERNAL_RPC_SECRET ?? "";

guildResourcesRouter.use(requireGuildAccess);

/**
 * Both routes below call the bot directly rather than through callBot, so
 * they never inherited its timeout. Without one they carry undici's default,
 * which is measured in minutes — and these are the channel and role dropdowns
 * in every form and panel editor, i.e. requests a human is sitting in front
 * of. Same reasoning and same budget as routes/overview.ts's fetchBotHealth:
 * if the bot is saturated holding the gateway open, this request hangs, and a
 * dropdown that says "bot unreachable" in two seconds beats one that spins.
 */
const BOT_TIMEOUT_MS = 2_000;

async function proxyToBot(path: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOT_TIMEOUT_MS);
  try {
    return await fetch(`${BOT_INTERNAL_URL}${path}`, {
      headers: { "X-Internal-Secret": INTERNAL_SECRET },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

guildResourcesRouter.get("/channels", async (req, res) => {
  try {
    const r = await proxyToBot(`/internal/guilds/${routeParams(req).guildId}/channels`);
    if (!r.ok) return res.status(502).json({ error: "bot_unreachable" });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
});

guildResourcesRouter.get("/roles", async (req, res) => {
  try {
    const r = await proxyToBot(`/internal/guilds/${routeParams(req).guildId}/roles`);
    if (!r.ok) return res.status(502).json({ error: "bot_unreachable" });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
});
