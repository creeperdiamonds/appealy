// bot/src/services/ticketService.ts
//
// Core open/close logic for the ticket system, shared by the panel button
// handler and any future slash-command entry point. Handles all three
// channelType modes uniformly so callers don't need to branch.

import { eq, and } from "drizzle-orm";
import type { ActionRow } from "@discordeno/bot";
import type { PermissionStrings } from "@discordeno/bot";
import { OverwriteTypes } from "@discordeno/bot";
import { MessageComponentTypes, ButtonStyles } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { countRows } from "../db/count.ts";
import { encodeCustomId } from "../../../shared/types/index.ts";
import { renderTranscript, type TranscriptMessage } from "../../../shared/lib/transcript.ts";
import { checkAndConsumeDailyCap } from "./rateLimitService.ts";
import { logger } from "../utils/logger.ts";
import { describeDiscordError } from "../utils/discordError.ts";

const ChannelTypes = {
  GuildText: 0,
  PrivateThread: 12,
  PublicThread: 11,
};

export interface OpenTicketResult {
  ok: boolean;
  reason?: "max_open_reached" | "config_inactive" | "creation_failed" | "guild_rate_limited";
  ticketId?: string;
  channelId?: bigint;
}

export async function openTicket(
  bot: AppealyBot,
  guildId: bigint,
  configId: string,
  openerId: bigint,
  openerUsername: string,
): Promise<OpenTicketResult> {
  const config = await db.query.ticketConfigs.findFirst({ where: eq(schema.ticketConfigs.id, configId) });
  if (!config || !config.active) return { ok: false, reason: "config_inactive" };

  const rateLimit = await checkAndConsumeDailyCap(guildId, "ticketsPerDay");
  if (!rateLimit.allowed) {
    return { ok: false, reason: "guild_rate_limited" };
  }

  const openCount = await countRows(
    schema.tickets,
    and(
      eq(schema.tickets.configId, configId),
      eq(schema.tickets.openerId, openerId),
      eq(schema.tickets.status, "open"),
    ),
  );
  if (openCount >= config.maxOpenPerUser) {
    return { ok: false, reason: "max_open_reached" };
  }

  const ticketName = config.ticketNameFormat
    .replace("{username}", openerUsername)
    .slice(0, 100);

  let channelId: bigint;
  try {
    channelId = await createTicketChannel(bot, guildId, config, ticketName, openerId);
  } catch (err) {
    logger.error("Failed to create ticket channel/thread", { configId, error: String(err) });
    return { ok: false, reason: "creation_failed" };
  }

  const [ticket] = await db
    .insert(schema.tickets)
    .values({ configId, guildId, openerId, channelId, status: "open" })
    .returning();

  const pingContent = config.pingRoleIds.length > 0 ? config.pingRoleIds.map((r) => `<@&${r}>`).join(" ") : "";
  await bot.helpers.sendMessage(channelId, {
    content: `${pingContent}${pingContent ? " " : ""}<@${openerId}>`,
    allowedMentions: { roles: config.pingRoleIds.map((r) => BigInt(r)), users: [openerId] },
    embeds: [
      {
        title: config.name,
        description: config.welcomeMessage ?? "Thanks for opening a ticket.",
        color: 0x5865f2,
        footer: { text: `Ticket ID: ${ticket.id}` },
      },
    ],
    components: [
      {
        type: MessageComponentTypes.ActionRow,
        // One or two buttons depending on whether claiming is enabled, which
        // the tuple types above cannot express — hence the assertion.
        components: ([
          {
            type: MessageComponentTypes.Button,
            style: ButtonStyles.Danger,
            label: "Close Ticket",
            customId: encodeCustomId("ticket", "close", ticket.id),
          },
          // Claim button only shown when the config enables claiming —
          // some guilds run tickets without a claim workflow at all
          // (confirmed as a real toggle, not always-on, from the
          // reference dashboard's "Ticket Claiming" setting).
          ...(config.claimingEnabled
            ? [
                {
                  type: MessageComponentTypes.Button,
                  style: ButtonStyles.Secondary,
                  label: "Claim",
                  customId: encodeCustomId("ticket", "claim", ticket.id),
                },
              ]
            : []),
        ] as unknown as ActionRow["components"]),
      },
    ],
  });

  return { ok: true, ticketId: ticket.id, channelId };
}

async function createTicketChannel(
  bot: AppealyBot,
  guildId: bigint,
  config: typeof schema.ticketConfigs.$inferSelect,
  ticketName: string,
  openerId: bigint,
): Promise<bigint> {
  if (config.channelType === "private_channel") {
    const channel = await bot.helpers.createChannel(guildId, {
      name: ticketName,
      type: ChannelTypes.GuildText,
      parentId: config.categoryId ?? undefined,
      // Deny @everyone, allow the opener and each support role explicitly.
      // This is the standard "private ticket channel" permission pattern.
      permissionOverwrites: [
        // Permission NAMES, not a bitfield string. The numeric form was never
        // a valid overwrite for this client and the comments were the only
        // thing saying which bits they were.
        { id: guildId, type: OverwriteTypes.Role, deny: ["VIEW_CHANNEL"] },
        {
          id: openerId,
          type: OverwriteTypes.Member,
          allow: ["VIEW_CHANNEL", "SEND_MESSAGES"],
        },
        ...config.supportRoleIds.map((roleId) => ({
          id: BigInt(roleId),
          type: OverwriteTypes.Role,
          allow: ["VIEW_CHANNEL", "SEND_MESSAGES"] as PermissionStrings[],
        })),
      ],
    });
    return channel.id;
  }

  // Both thread modes are created under the config's designated channel.
  // private_thread requires the guild to have private threads available
  // (tied to boost level in Discord's own rules) — if that create call
  // fails, the caller's catch block surfaces "creation_failed" and staff
  // should reconfigure to private_channel or public_thread instead.
  const thread = await bot.helpers.startThreadWithoutMessage(config.channelId, {
    name: ticketName,
    type: config.channelType === "private_thread" ? ChannelTypes.PrivateThread : ChannelTypes.PublicThread,
    autoArchiveDuration: 1440,
    invitable: false,
  });

  await bot.helpers.addThreadMember(thread.id, openerId);
  return thread.id;
}

export async function closeTicket(
  bot: AppealyBot,
  ticketId: string,
  closedBy: bigint,
  reason: string | undefined,
) {
  const ticket = await db.query.tickets.findFirst({
    where: eq(schema.tickets.id, ticketId),
    with: { config: true },
  });
  if (!ticket || ticket.status === "closed") return null;

  let transcriptUrl: string | null = null;
  if (ticket.config.transcriptOnClose) {
    transcriptUrl = await generateAndPostTranscript(bot, ticket).catch((err) => {
      // Discordeno collapses every REST failure into the same generic
      // wrapper message, so a permission error, a closed channel, and a
      // network blip all used to log identically. describeDiscordError
      // walks the body/cause chain for whatever Discord actually said.
      const info = describeDiscordError(err);
      logger.warn("Transcript generation failed", {
        ticketId,
        status: info.status,
        code: info.code,
        detail: info.message,
      });
      return null;
    });
  }

  await db
    .update(schema.tickets)
    .set({ status: "closed", closedBy, closeReason: reason ?? null, closedAt: new Date(), transcriptUrl })
    .where(eq(schema.tickets.id, ticketId));

  if (ticket.config.ratingEnabled) {
    const { sendRatingPrompt } = await import("./ticketRatingService.ts");
    await sendRatingPrompt(bot, ticket.id, ticket.openerId);
  }

  try {
    if (ticket.config.channelType === "private_channel") {
      await bot.helpers.deleteChannel(ticket.channelId, reason ?? "Ticket closed");
    } else {
      await bot.helpers.editChannel(ticket.channelId, { archived: true, locked: true });
    }
  } catch (err) {
    logger.warn("Failed to archive/delete ticket channel on close", { ticketId, error: String(err) });
  }

  return { transcriptUrl };
}

/**
 * Fetches a ticket channel's history, renders it, posts it to the configured
 * transcript channel, and returns a link to that post.
 *
 * FOUR THINGS WERE WRONG HERE, three of them silent.
 *
 * 1. It fetched `{ limit: 100 }` once. That is Discord's per-call maximum, not
 *    a channel's message count — so any ticket longer than a hundred messages
 *    was transcribed from its last hundred, with nothing anywhere saying so.
 *    The busiest tickets, which are the ones a transcript is actually for,
 *    were the ones least likely to be complete. It pages now, and when it hits
 *    the cap the transcript says so in its own first line.
 *
 * 2. Attachments were dropped. core/client.ts caches them with the comment
 *    "Ticket transcripts include what was attached, not just what was typed"
 *    — the intent was written down in one file and never implemented in this
 *    one. A screenshot rendered as an empty line.
 *
 * 3. It returned the posted attachment's CDN url, and that url expires.
 *    Discord signs attachment links and they stop resolving after about a
 *    day, so `tickets.transcript_url` was filling up with links that were dead
 *    before anyone clicked them. It returns a MESSAGE link now: permanent,
 *    and it lands on the post, from which the file downloads with a fresh
 *    signature.
 *
 * 4. It read the whole channel and then discarded the result when no
 *    transcript channel was configured. Harmless at one REST call; not
 *    harmless now that it pages. The check moved to the top.
 *
 * Rendering is in shared/lib/transcript.ts so it can be tested without a
 * gateway connection. See shared/lib/__tests__/transcript.test.ts — every case
 * in it is one of the above.
 */

/** Discord's own per-request maximum. Not a choice. */
const TRANSCRIPT_PAGE = 100;

/**
 * Ten pages, so a thousand messages.
 *
 * A bound is necessary — without one, one pathological channel blocks a close
 * behind an unbounded number of REST calls. A thousand is well past any real
 * support ticket, and the transcript is explicit when it is reached, which is
 * the part that makes the limit honest rather than lossy.
 */
const TRANSCRIPT_MAX_PAGES = 10;

async function generateAndPostTranscript(
  bot: AppealyBot,
  ticket: typeof schema.tickets.$inferSelect & { config: typeof schema.ticketConfigs.$inferSelect },
): Promise<string | null> {
  // Before the work, not after it.
  if (!ticket.config.transcriptChannelId) return null;

  const collected: TranscriptMessage[] = [];
  let before: bigint | undefined;
  let truncated = false;

  for (let page = 0; page < TRANSCRIPT_MAX_PAGES; page++) {
    const batch = await bot.helpers.getMessages(ticket.channelId, {
      limit: TRANSCRIPT_PAGE,
      ...(before ? { before } : {}),
    });
    const rows = [...batch];
    if (rows.length === 0) break;

    collected.push(...rows);
    // Discord returns newest first, so the last row of a page is the oldest
    // one seen — which is where the next page continues from.
    before = rows[rows.length - 1].id;

    if (rows.length < TRANSCRIPT_PAGE) break;
    if (page === TRANSCRIPT_MAX_PAGES - 1) truncated = true;
  }

  const transcriptText = renderTranscript(collected.reverse(), { truncated });

  const file = {
    blob: new Blob([new TextEncoder().encode(transcriptText)], { type: "text/plain" }),
    name: `ticket-${ticket.id}.txt`,
  };

  const posted = await bot.helpers.sendMessage(ticket.config.transcriptChannelId, {
    content: `Transcript for ticket \`${ticket.id}\` (opened by <@${ticket.openerId}>)`,
    files: [file],
  });

  // A message link rather than posted.attachments[0].url. See (3) above.
  if (!posted?.id) return null;
  return `https://discord.com/channels/${ticket.guildId}/${ticket.config.transcriptChannelId}/${posted.id}`;
}
