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

/** Renders a plain-text transcript of the ticket channel's message history
 * and posts it to the configured transcript channel (if set) as a file
 * attachment. Kept intentionally simple (text, not HTML) to avoid pulling
 * in a rendering dependency for what's fundamentally a compliance/reference
 * artifact rather than a polished deliverable. */
async function generateAndPostTranscript(
  bot: AppealyBot,
  ticket: typeof schema.tickets.$inferSelect & { config: typeof schema.ticketConfigs.$inferSelect },
): Promise<string | null> {
  const messages = await bot.helpers.getMessages(ticket.channelId, { limit: 100 });
  const lines = [...messages]
    .reverse()
    .map((m) => `[${new Date(m.timestamp ?? Date.now()).toISOString()}] ${m.author?.username ?? "unknown"}: ${m.content ?? ""}`);
  const transcriptText = lines.join("\n") || "(no messages)";

  if (!ticket.config.transcriptChannelId) return null;

  const file = {
    blob: new Blob([new TextEncoder().encode(transcriptText)], { type: "text/plain" }),
    name: `ticket-${ticket.id}.txt`,
  };

  const posted = await bot.helpers.sendMessage(ticket.config.transcriptChannelId, {
    content: `Transcript for ticket \`${ticket.id}\` (opened by <@${ticket.openerId}>)`,
    files: [file],
  });

  const attachment = posted.attachments?.[0];
  return attachment?.url ?? null;
}
