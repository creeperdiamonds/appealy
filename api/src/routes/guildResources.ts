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

async function proxyToBot(path: string, timeoutMs: number = BOT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
  // ?all=1 adds voice, forum and category channels, for the AutoMod page's
  // "channels this rule ignores". Every other picker is choosing somewhere to
  // post, so it keeps the text-only list.
  const all = req.query.all === "1" ? "?all=1" : "";
  try {
    const r = await proxyToBot(`/internal/guilds/${routeParams(req).guildId}/channels${all}`);
    if (!r.ok) return res.status(502).json({ error: "bot_unreachable" });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "bot_unreachable", detail: String(err) });
  }
});

// The Overview page's setup check: what about this server's setup will fail
// quietly (bot/src/services/setupCheck.ts). Several Discord reads, so it gets
// longer than the pickers' two seconds.
guildResourcesRouter.get("/setup-check", async (req, res) => {
  try {
    const r = await proxyToBot(`/internal/guilds/${routeParams(req).guildId}/setup-check`, 8_000);
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
