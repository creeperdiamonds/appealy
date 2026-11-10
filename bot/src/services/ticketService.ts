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
import { onlySnowflakes } from "../../../shared/lib/snowflake.ts";
import {
  effectiveTicketSettings,
  slugForChannelName,
  type EffectiveTicketSettings,
} from "../../../shared/lib/ticketCategory.ts";
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
  reason?:
    | "max_open_reached"
    | "config_inactive"
    | "category_missing"
    | "creation_failed"
    | "missing_permission"
    | "guild_rate_limited";
  ticketId?: string;
  channelId?: bigint;
}

export interface OpenTicketOptions {
  /** The panel button (ticket category) that was clicked, if the panel has any. */
  categoryId?: string | null;
  /** The member's answers to the category's questions, in question order. */
  answers?: { label: string; value: string }[];
}

export async function openTicket(
  bot: AppealyBot,
  guildId: bigint,
  configId: string,
  openerId: bigint,
  openerUsername: string,
  opts: OpenTicketOptions = {},
): Promise<OpenTicketResult> {
  const config = await db.query.ticketConfigs.findFirst({
    where: eq(schema.ticketConfigs.id, configId),
    with: { categories: true },
  });
  if (!config || !config.active) return { ok: false, reason: "config_inactive" };

  // A panel with categories only opens through one of them, and the category
  // must belong to this config: the id comes from a button's custom_id, which
  // outlives edits (a deleted category's old panel button still exists).
  const category = opts.categoryId ? config.categories.find((c) => c.id === opts.categoryId) ?? null : null;
  if (opts.categoryId && !category) return { ok: false, reason: "category_missing" };
  const settings = effectiveTicketSettings(config, category);

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
    .replace("{category}", category ? slugForChannelName(category.label) : "")
    .slice(0, 100);

  let channelId: bigint;
  try {
    channelId = await createTicketChannel(bot, guildId, config, settings, ticketName, openerId);
  } catch (err) {
    logger.error("Failed to create ticket channel/thread", { configId, error: String(err) });
    // Told apart because it's the one staff can fix, and the one a server
    // that invited Appealy without Manage Channels always hits.
    const { code } = describeDiscordError(err);
    const refused = code === 50013 || code === 50001; // Missing Permissions, Missing Access
    return { ok: false, reason: refused ? "missing_permission" : "creation_failed" };
  }

  const [ticket] = await db
    .insert(schema.tickets)
    .values({ configId, ticketCategoryId: category?.id ?? null, guildId, openerId, channelId, status: "open" })
    .returning();

  const pingRoleIds = onlySnowflakes(settings.pingRoleIds);
  const pingContent = pingRoleIds.length > 0 ? pingRoleIds.map((r) => `<@&${r}>`).join(" ") : "";
  await bot.helpers.sendMessage(channelId, {
    content: `${pingContent}${pingContent ? " " : ""}<@${openerId}>`,
    allowedMentions: { roles: pingRoleIds.map((r) => BigInt(r)), users: [openerId] },
    embeds: [
      {
        title: settings.title.slice(0, 256),
        description: settings.welcomeMessage ?? "Thanks for opening a ticket.",
        color: 0x5865f2,
        // Embed limits: 25 fields, 256 for a name, 1024 for a value.
        fields: (opts.answers ?? [])
          .filter((a) => a.value.trim().length > 0)
          .slice(0, 25)
          .map((a) => ({ name: a.label.slice(0, 256), value: a.value.slice(0, 1024) })),
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
  settings: EffectiveTicketSettings,
  ticketName: string,
  openerId: bigint,
): Promise<bigint> {
  if (config.channelType === "private_channel") {
    const channel = await bot.helpers.createChannel(guildId, {
      name: ticketName,
      type: ChannelTypes.GuildText,
      parentId: settings.parentCategoryId ?? undefined,
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
        ...onlySnowflakes(settings.supportRoleIds).map((roleId) => ({
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
    with: { config: true, category: true },
  });
  if (!ticket || ticket.status === "closed") return null;
  const settings = effectiveTicketSettings(ticket.config, ticket.category);

  // "Keep closed tickets" (stored as transcript_on_close, its old name): the
  // conversation stays where it happened, read-only, instead of being copied
  // out. Copying it out meant reading every message, which needs the Message
  // Content intent, and Appealy doesn't use that any more (2026-11-10).
  const keep = ticket.config.transcriptOnClose;
  const conversationUrl = keep ? `https://discord.com/channels/${ticket.guildId}/${ticket.channelId}` : null;

  await db
    .update(schema.tickets)
    .set({
      status: "closed",
      closedBy,
      closeReason: reason ?? null,
      closedAt: new Date(),
      transcriptUrl: conversationUrl,
    })
    .where(eq(schema.tickets.id, ticketId));

  if (ticket.config.ratingEnabled) {
    const { sendRatingPrompt } = await import("./ticketRatingService.ts");
    await sendRatingPrompt(bot, ticket.id, ticket.openerId);
  }

  try {
    if (ticket.config.channelType !== "private_channel") {
      await bot.helpers.editChannel(ticket.channelId, { archived: true, locked: true });
    } else if (keep) {
      await bot.helpers.editChannel(ticket.channelId, {
        name: closedName(ticket.id),
        permissionOverwrites: closedOverwrites(ticket.guildId, ticket.openerId, settings.supportRoleIds),
      } as never, reason ?? "Ticket closed");
    } else {
      await bot.helpers.deleteChannel(ticket.channelId, reason ?? "Ticket closed");
    }
  } catch (err) {
    const info = describeDiscordError(err);
    logger.warn("Failed to archive/lock/delete ticket channel on close", {
      ticketId,
      status: info.status,
      code: info.code,
      detail: info.message,
    });
  }

  if (keep) await logClosedTicket(bot, ticket, closedBy, reason);

  return { conversationUrl };
}

/** "closed-" and the start of the ticket ID, so closed tickets sort together and are easy to tell apart. */
function closedName(ticketId: string): string {
  return `closed-${ticketId.slice(0, 8)}`;
}

/**
 * A closed private channel: still hidden from everyone else, still readable by
 * the opener and the support roles, and nobody but admins can post in it.
 */
export function closedOverwrites(guildId: bigint, openerId: bigint, supportRoleIds: readonly string[]) {
  const readOnly = { allow: ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"], deny: ["SEND_MESSAGES"] } as {
    allow: PermissionStrings[];
    deny: PermissionStrings[];
  };
  return [
    { id: guildId, type: OverwriteTypes.Role, deny: ["VIEW_CHANNEL"] as PermissionStrings[] },
    { id: openerId, type: OverwriteTypes.Member, ...readOnly },
    ...onlySnowflakes(supportRoleIds).map((roleId) => ({ id: BigInt(roleId), type: OverwriteTypes.Role, ...readOnly })),
  ];
}

/**
 * Who closed which ticket, and where to read it, in the log channel. Only the
 * close details: Appealy doesn't read or copy the conversation itself.
 */
async function logClosedTicket(
  bot: AppealyBot,
  ticket: typeof schema.tickets.$inferSelect & { config: typeof schema.ticketConfigs.$inferSelect },
  closedBy: bigint,
  reason: string | undefined,
) {
  const logChannelId = ticket.config.transcriptChannelId;
  if (!logChannelId) return;
  try {
    await bot.helpers.sendMessage(logChannelId, {
      content: [
        `Ticket \`${ticket.id}\` (${ticket.config.name}) opened by <@${ticket.openerId}> was closed by <@${closedBy}>.`,
        reason ? `Reason: ${reason.slice(0, 500)}` : null,
        `The conversation is kept, read-only, in <#${ticket.channelId}>.`,
      ].filter(Boolean).join("\n"),
      allowedMentions: { parse: [] },
    } as never);
  } catch (err) {
    const info = describeDiscordError(err);
    logger.warn("Couldn't post a closed ticket to its log channel", { ticketId: ticket.id, code: info.code, detail: info.message });
  }
}

