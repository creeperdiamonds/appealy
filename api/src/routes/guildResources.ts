// api/src/routes/guildResources.ts
//
// The dashboard's form/panel builder needs live lists of the guild's
// channels and roles for pickers (log channel select, grant-role select,
// etc). This data is only available via the bot's REST session (using the
// bot token, which the API process never holds directly), so it's proxied
// through the same internal control-server pattern as botBridge.ts.
// Mounted at /api/guilds/:guildId/resources

import { Router } from "express";
import { requireGuildAccess } from "../middleware/guildAccess.ts";

export const guildResourcesRouter = Router({ mergeParams: true });

const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL ?? "http://bot:9090";
const INTERNAL_SECRET = process.env.INTERNAL_RPC_SECRET ?? "";

guildResourcesRouter.use(requireGuildAccess);

guildResourcesRouter.get("/channels", async (req, res) => {
  try {
    const r = await fetch(`${BOT_INTERNAL_URL}/internal/guilds/${req.params.guildId}/channels`, {
      headers: { "X-Internal-Secret": INTERNAL_SECRET },
    });
    if (!r.ok) return res.status(502).json({ error: "bot_unreachable" });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
});

guildResourcesRouter.get("/roles", async (req, res) => {
  try {
    const r = await fetch(`${BOT_INTERNAL_URL}/internal/guilds/${req.params.guildId}/roles`, {
      headers: { "X-Internal-Secret": INTERNAL_SECRET },
    });
    if (!r.ok) return res.status(502).json({ error: "bot_unreachable" });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
});
