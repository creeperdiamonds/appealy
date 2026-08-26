// bot/src/core/controlServer.ts
//
// Small internal HTTP server, reachable only on the private service
// network (never expose this port publicly), that lets the stateless API
// process trigger actions which require the bot's live gateway/REST
// session — publishing a panel message, re-syncing an edited panel,
// publishing a poll immediately instead of waiting for the scheduler.
//
// Authenticated via a shared secret header rather than full OAuth since
// this is service-to-service, not user-facing.

import { eq } from "drizzle-orm";
import type { MessageComponent } from "@discordeno/bot";
import type { ActionRow } from "@discordeno/bot";
import { MessageComponentTypes, ButtonStyles } from "@discordeno/bot";
import type { AppealyBot } from "./client.ts";
import { db, schema } from "../db/client.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { publishPoll } from "../services/pollService.ts";
import { publishTicketPanel } from "../services/ticketPanelService.ts";
import { publishGiveaway, endGiveaway } from "../services/giveawayService.ts";
import { publishVerificationPanel } from "../services/verificationPanelService.ts";
import { publishRoleMenu } from "../services/roleMenuService.ts";
import { cacheStats, invalidateGuild } from "./guildConfigCache.ts";
import { applyBanChange } from "./banCache.ts";
import { withRedis } from "./redis.ts";
import { logger } from "../utils/logger.ts";

// PORT is injected by Cloud Run and the container must listen on it, or the
// service fails its health check with no useful error. BOT_INTERNAL_PORT stays
// first so a self-hosted deployment can still pin it explicitly.
const PORT = Number(Deno.env.get("BOT_INTERNAL_PORT") ?? Deno.env.get("PORT") ?? "9090");
const SECRET = Deno.env.get("INTERNAL_RPC_SECRET") ?? "";

export function startControlServer(bot: AppealyBot) {
  Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
    if (req.headers.get("X-Internal-Secret") !== SECRET || !SECRET) {
      return new Response("unauthorized", { status: 401 });
    }

    const url = new URL(req.url);

    try {
      if (url.pathname === "/internal/panels/publish" && req.method === "POST") {
        const { panelId } = await req.json();
        await publishPanel(bot, panelId);
        return Response.json({ status: "published" });
      }

      if (url.pathname === "/internal/panels/sync" && req.method === "POST") {
        const { panelId } = await req.json();
        await syncPanel(bot, panelId);
        return Response.json({ status: "synced" });
      }

      if (url.pathname === "/internal/polls/publish" && req.method === "POST") {
        const { pollId } = await req.json();
        await publishPoll(bot, pollId);
        return Response.json({ status: "published" });
      }

      // Health, for the dashboard's bot panel and for container probes.
      // Deliberately unauthenticated-adjacent (still behind the shared
      // secret, still on the private network) and deliberately cheap — a
      // health check that queries Postgres becomes the thing that tips an
      // already-struggling process over.
      if (url.pathname === "/internal/health" && req.method === "GET") {
        const cache = cacheStats();
        const redisOk = await withRedis(async (r) => {
          await r.ping();
          return true;
        }, false);

        return Response.json({
          status: redisOk ? "ok" : "degraded",
          redis: redisOk ? "up" : "down",
          uptimeSeconds: Math.floor(performance.now() / 1000),
          guildsCached: cache.l1Live,
          cacheEntries: cache.l1Entries,
          inFlightCacheLoads: cache.inFlightLoads,
          // Shard state is what actually tells you whether the bot is
          // healthy — a process can be up, responsive, and completely
          // disconnected from Discord.
          shards: collectShardStatus(bot),
          memoryMb: Math.round((Deno.memoryUsage?.().rss ?? 0) / 1024 / 1024),
        });
      }

      const channelsMatch = url.pathname.match(/^\/internal\/guilds\/(\d+)\/channels$/);
      if (channelsMatch && req.method === "GET") {
        return Response.json(await getChannelsCached(bot, channelsMatch[1]));
      }

      const rolesMatch = url.pathname.match(/^\/internal\/guilds\/(\d+)\/roles$/);
      if (rolesMatch && req.method === "GET") {
        return Response.json(await getRolesCached(bot, rolesMatch[1]));
      }

      if (url.pathname === "/internal/tickets/publish-panel" && req.method === "POST") {
        const { configId } = await req.json();
        await publishTicketPanel(bot, configId);
        return Response.json({ status: "published" });
      }

      if (url.pathname === "/internal/giveaways/publish" && req.method === "POST") {
        const { giveawayId } = await req.json();
        await publishGiveaway(bot, giveawayId);
        return Response.json({ status: "published" });
      }

      if (url.pathname === "/internal/giveaways/end" && req.method === "POST") {
        const { giveawayId } = await req.json();
        const winners = await endGiveaway(bot, giveawayId);
        return Response.json({ winners });
      }

      if (url.pathname === "/internal/giveaways/reroll" && req.method === "POST") {
        const { giveawayId } = await req.json();
        const winners = await endGiveaway(bot, giveawayId, true);
        return Response.json({ winners });
      }

      if (url.pathname === "/internal/verification/publish" && req.method === "POST") {
        const { guildId } = await req.json();
        await publishVerificationPanel(bot, BigInt(guildId));
        return Response.json({ status: "published" });
      }

      if (url.pathname === "/internal/role-menus/publish" && req.method === "POST") {
        const { menuId } = await req.json();
        await publishRoleMenu(bot, menuId);
        return Response.json({ status: "published" });
      }

      // Clearing a lockdown is not a Discord call — it is a cache eviction,
      // and the cache belongs to this process. The API cannot do it itself:
      // with the in-memory Redis substitute the two processes hold separate
      // copies, so an eviction on the API side reaches nothing, and even with
      // a real Redis the key format would have to be duplicated there and kept
      // in step. Delegating keeps one implementation.
      if (url.pathname === "/internal/anti-raid/clear-lockdown" && req.method === "POST") {
        const { guildId, clearedBy } = await req.json();
        const { clearLockdown } = await import("../services/antiRaidService.ts");
        const cleared = await clearLockdown(BigInt(guildId), BigInt(clearedBy));
        return Response.json({ cleared });
      }

      if (url.pathname === "/internal/sticky-messages/publish" && req.method === "POST") {
        const { stickyId } = await req.json();
        const { publishStickyMessage } = await import("../services/stickyMessageService.ts");
        await publishStickyMessage(bot, stickyId);
        return Response.json({ status: "published" });
      }

      // Cache invalidation, for deployments without a real Redis.
      //
      // With REDIS_URL set to the memory substitute the API's publish goes
      // into its own process and the bot never hears it, so an admin saves a
      // form and the bot serves the old one until the TTL expires. The API
      // and bot share one Cloud Run instance and this authenticated channel,
      // so it carries the message for free — Memorystore plus the VPC
      // connector it needs is about $420 a year, which is not yet worth
      // paying to fix this, on a product with one guild on it. See
      // cacheInvalidation.ts and banGate.ts on the API side, which choose
      // this transport over Redis pub/sub only when useMemoryRedis() is true;
      // Redis becomes correct again the moment there is more than one bot
      // instance to fan this out to.
      if (url.pathname === "/internal/cache/invalidate" && req.method === "POST") {
        const { guildId } = await req.json();
        await invalidateGuild(guildId);
        return Response.json({ status: "invalidated" });
      }

      if (url.pathname === "/internal/cache/ban" && req.method === "POST") {
        const msg = await req.json();
        applyBanChange(msg);
        return Response.json({ status: "applied" });
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      logger.error("Control server request failed", { path: url.pathname, error: String(err) });
      return Response.json({ error: String(err) }, { status: 500 });
    }
  });

  logger.info("Internal control server listening", { port: PORT });
}

async function publishPanel(bot: AppealyBot, panelId: string) {
  const panel = await db.query.panels.findFirst({
    where: eq(schema.panels.id, panelId),
    with: { buttons: { orderBy: (b, { asc }) => [asc(b.sortOrder)] } },
  });
  if (!panel) throw new Error("panel_not_found");

  const message = await bot.helpers.sendMessage(panel.channelId, buildPanelMessage(panel));

  await db
    .update(schema.panels)
    .set({ messageId: message.id, published: true })
    .where(eq(schema.panels.id, panelId));
}

async function syncPanel(bot: AppealyBot, panelId: string) {
  const panel = await db.query.panels.findFirst({
    where: eq(schema.panels.id, panelId),
    with: { buttons: { orderBy: (b, { asc }) => [asc(b.sortOrder)] } },
  });
  if (!panel || !panel.messageId) throw new Error("panel_not_published");

  await bot.helpers.editMessage(panel.channelId, panel.messageId, buildPanelMessage(panel));
}

const STYLE_MAP: Record<string, ButtonStyles> = {
  primary: ButtonStyles.Primary,
  secondary: ButtonStyles.Secondary,
  success: ButtonStyles.Success,
  danger: ButtonStyles.Danger,
};

function buildPanelMessage(
  panel: typeof schema.panels.$inferSelect & {
    buttons: (typeof schema.panelButtons.$inferSelect & { formName?: string })[];
  },
) {
  const embed = {
    title: panel.title,
    description: panel.description ?? "",
    color: panel.color ?? 0x5865f2,
    image: panel.imageUrl ? { url: panel.imageUrl } : undefined,
    thumbnail: panel.thumbnailUrl ? { url: panel.thumbnailUrl } : undefined,
    footer: panel.footerText ? { text: panel.footerText } : undefined,
  };

  if (panel.displayType === "dropdown") {
    // Dropdown mode: a single select menu listing every attached form.
    // Discord select menus cap at 25 options, well above the 5-button
    // action-row limit, which is the whole point of offering this mode.
    const options = panel.buttons.slice(0, 25);
    // Annotated rather than inferred: without a contextual type the `type`
    // fields widen to the enum itself and no payload will accept them.
    const components: MessageComponent[] = [
        {
          type: MessageComponentTypes.ActionRow,
          components: [
            {
              type: MessageComponentTypes.SelectMenu,
              customId: encodeCustomId("panel", "select_open", panel.id),
              placeholder: "Choose an application to apply for",
              minValues: 1,
              maxValues: 1,
              options: options.map((b) => ({
                label: b.label,
                value: b.formId,
                emoji: b.emoji ? { name: b.emoji } : undefined,
              })),
            },
          ] as ActionRow["components"],
        },
    ];
    return { embeds: [embed], components };
  }

  // Discord caps 5 components per action row; panels supporting more than
  // 5 forms in button mode should split into multiple panels or switch to
  // dropdown mode (enforced/suggested dashboard-side).
  const buttons = panel.buttons.slice(0, 5);
  const components: MessageComponent[] = [
    {
      type: MessageComponentTypes.ActionRow,
      // One to five buttons, decided by how many forms the panel has — a
      // length the tuple types cannot express.
      components: buttons.map((b) => ({
        type: MessageComponentTypes.Button as const,
        style: STYLE_MAP[b.style] ?? ButtonStyles.Primary,
        label: b.label,
        emoji: b.emoji ? { name: b.emoji } : undefined,
        customId: encodeCustomId("panel", "open", b.formId),
      })) as unknown as ActionRow["components"],
    },
  ];
  return { embeds: [embed], components };
}


// ---------------------------------------------------------------------------
// Channel and role pickers
//
// These two endpoints back every dropdown in the dashboard's form and panel
// builders — log channel, grant roles, ping roles, ticket category, and so
// on. A single form editor screen can request them several times, and each
// uncached request is a Discord REST call using the bot token.
//
// That matters more than an ordinary cache miss would, because these calls
// share the bot's global REST rate limit with everything users are doing
// live: publishing panels, granting roles on accept, posting review embeds.
// An admin idly reopening the form builder should not be able to consume
// the same budget that a member's application acceptance needs.
//
// 60 seconds is chosen against the actual usage pattern: a channel or role
// created specifically so it can be selected here will be a few seconds
// old, so the cache is bypassed with ?fresh=1 from the dashboard's refresh
// button rather than making everyone pay for the rare case.
// ---------------------------------------------------------------------------

const PICKER_CACHE_SECONDS = 60;

async function getChannelsCached(bot: AppealyBot, guildId: string) {
  const key = `appealy:picker:channels:${guildId}`;
  const cached = await withRedis<string | null>((r) => r.get(key), null);
  if (cached) return JSON.parse(cached);

  const channels = await bot.helpers.getChannels(BigInt(guildId));
  const payload = channels
    .filter((c) => c.type === 0 || c.type === 5) // text + announcement only
    .map((c) => ({
      id: c.id.toString(),
      name: c.name,
      type: c.type,
      position: c.position,
    }));

  await withRedis((r) => r.set(key, JSON.stringify(payload), { ex: PICKER_CACHE_SECONDS }), null);
  return payload;
}

async function getRolesCached(bot: AppealyBot, guildId: string) {
  const key = `appealy:picker:roles:${guildId}`;
  const cached = await withRedis<string | null>((r) => r.get(key), null);
  if (cached) return JSON.parse(cached);

  const guild = await bot.helpers.getGuild(BigInt(guildId));
  const payload = guild.roles
    .filter((r) => r.name !== "@everyone")
    .map((r) => ({
      id: r.id.toString(),
      name: r.name,
      color: r.color,
      position: r.position,
    }));

  await withRedis((r) => r.set(key, JSON.stringify(payload), { ex: PICKER_CACHE_SECONDS }), null);
  return payload;
}

/**
 * Best-effort shard status.
 *
 * Written defensively on purpose. bot/src/core/client.ts already documents
 * that Discordeno's gateway internals shift between releases, and this is
 * a health endpoint — the one thing that must never throw is the code that
 * tells you whether things are throwing. If the shape isn't what we expect,
 * report unknown rather than crashing the check.
 */
function collectShardStatus(bot: AppealyBot) {
  try {
    const gateway = (bot as unknown as {
      gateway?: { shards?: Map<number, { id: number; state?: number; heart?: { rtt?: number } }> };
    }).gateway;

    if (!gateway?.shards) return { available: false, shards: [] };

    return {
      available: true,
      shards: [...gateway.shards.values()].map((s) => ({
        id: s.id,
        state: s.state ?? null,
        rttMs: s.heart?.rtt ?? null,
      })),
    };
  } catch {
    return { available: false, shards: [] };
  }
}
