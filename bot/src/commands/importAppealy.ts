// bot/src/commands/importAppealy.ts
// /import-appealy — stand up another server's Appealy configuration here.
//
// The receiving half of /export. Owner-only, and for a sharper reason than the
// export is: exporting reads your own server, importing WRITES to this one and
// in replace mode deletes what is already here. That is not something to let a
// delegated manager do on the strength of a file they were handed.
//
// The interesting work is all in shared/services/dataImport.ts — in particular
// why a form that loses its role gating is imported switched off rather than
// wide open, and why nothing anyone submitted in the source server comes
// across. This file is the Discord end of it: read the attachment, run the
// import, and report what needs reconnecting in a form someone can act on.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { AppealyBot } from "../core/client.ts";
import { db } from "../db/client.ts";
import { isGuildOwner } from "../services/permissionService.ts";
import { importGuildData, type ImportReport } from "../../../shared/services/dataImport.ts";
import { logger } from "../utils/logger.ts";

const EPHEMERAL = 64;

export const definition: CreateApplicationCommand = {
  name: "import-appealy",
  description: "Import another server's Appealy setup from an /export file",
  type: ApplicationCommandTypes.ChatInput,
  defaultMemberPermissions: ["ADMINISTRATOR"],
  options: [
    {
      name: "file",
      description: "The .json file produced by /export in the other server",
      type: ApplicationCommandOptionTypes.Attachment,
      required: true,
    },
    {
      name: "fallback_channel",
      description: "Where anything that must have a channel lands until you move it",
      type: ApplicationCommandOptionTypes.Channel,
      required: true,
    },
    {
      name: "replace",
      description: "Delete this server's existing Appealy config first (default: no, add alongside)",
      type: ApplicationCommandOptionTypes.Boolean,
      required: false,
    },
  ],
};

async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 4,
    data: { flags: EPHEMERAL, content },
  });
}

/**
 * The report as something worth reading in Discord.
 *
 * The counts matter least. What an admin actually needs is the list of things
 * that are now pointing somewhere temporary, and the forms that came in
 * switched off — so those go first and the totals go last.
 */
function formatReport(report: ImportReport): string {
  const lines: string[] = [];

  if (report.deactivated.length > 0) {
    lines.push(`**${report.deactivated.length} form(s) imported SWITCHED OFF.**`);
    lines.push(
      "Their role gating named roles from the other server. Left active they would have been open to everyone here.",
    );
    for (const d of report.deactivated.slice(0, 10)) lines.push(`• ${d.name}`);
    lines.push("Reconnect the roles, then re-enable them.");
    lines.push("");
  }

  if (report.reconnect.length > 0) {
    const fallback = report.reconnect.filter((r) => r.action !== "cleared").length;
    const cleared = report.reconnect.length - fallback;
    lines.push(`**${report.reconnect.length} setting(s) need a channel or role reconnected.**`);
    if (fallback > 0) lines.push(`• ${fallback} pointed at the fallback channel`);
    if (cleared > 0) lines.push(`• ${cleared} cleared`);
    for (const r of report.reconnect.slice(0, 15)) {
      lines.push(`  – ${r.kind} "${r.name}" → ${r.field}`);
    }
    if (report.reconnect.length > 15) {
      lines.push(`  – …and ${report.reconnect.length - 15} more`);
    }
    lines.push("");
  }

  if (report.skipped.length > 0) {
    lines.push(`**${report.skipped.length} item(s) skipped.**`);
    for (const sk of report.skipped.slice(0, 10)) {
      lines.push(`• ${sk.kind} "${sk.name}" — ${sk.why}`);
    }
    lines.push("");
  }

  const created = Object.entries(report.created)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
  lines.push(`**Created:** ${created || "nothing"}`);
  lines.push(
    "Submissions, tickets, appeals and staff delegations are never imported — they belong to the other server's members.",
  );

  const out = lines.join("\n");
  // Discord truncates at 2000; better to say it was cut than to be cut.
  return out.length > 1900 ? out.slice(0, 1900) + "\n…report truncated." : out;
}

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const requester = interaction.member?.user ?? interaction.user;
  if (!guildId || !requester) return;

  if (!(await isGuildOwner(bot, guildId, requester.id))) {
    return respond(
      bot,
      interaction,
      "Only the server owner can import a configuration. This writes to the server, and in replace mode deletes what is already here.",
    );
  }

  const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
  const attachment = interaction.data?.resolved?.attachments?.get?.(BigInt(String(opts.file)));
  const fallbackChannelId = opts.fallback_channel;
  const replace = Boolean(opts.replace);

  if (!attachment) {
    return respond(bot, interaction, "Could not read the uploaded file. Please try again.");
  }
  if (!attachment.filename.toLowerCase().endsWith(".json")) {
    return respond(bot, interaction, "Please upload the .json file produced by `/export`.");
  }
  if (attachment.size > 25 * 1024 * 1024) {
    return respond(bot, interaction, "That file is too large to import in one go.");
  }
  if (!fallbackChannelId) {
    return respond(bot, interaction, "Pick a fallback channel — several settings cannot be left empty.");
  }

  await respond(
    bot,
    interaction,
    replace
      ? "Replacing this server's Appealy configuration — this may take a moment…"
      : "Importing — this may take a moment…",
  );

  try {
    const fileRes = await fetch(attachment.url);
    if (!fileRes.ok) throw new Error(`Failed to download attachment: ${fileRes.status}`);
    const payload = JSON.parse(await fileRes.text()) as Record<string, unknown>;

    if (!payload || typeof payload !== "object" || !("exportVersion" in payload)) {
      await bot.helpers.editOriginalInteractionResponse(interaction.token, {
        content:
          "That file doesn't look like an Appealy export — it has no `exportVersion`. Use the file from `/export`, not one from another bot (for Appy submissions, use `/import-appy`).",
      });
      return;
    }

    const report = await importGuildData(db, payload, {
      targetGuildId: guildId,
      fallbackChannelId: BigInt(String(fallbackChannelId)),
      actorId: requester.id,
      mode: replace ? "replace" : "append",
    });

    logger.info("Appealy configuration imported", {
      guildId: guildId.toString(),
      actorId: requester.id.toString(),
      mode: replace ? "replace" : "append",
      created: report.created,
      needsReconnecting: report.reconnect.length,
      deactivated: report.deactivated.length,
    });

    await bot.helpers.editOriginalInteractionResponse(interaction.token, {
      content: formatReport(report),
    });
  } catch (err) {
    logger.error("Appealy import failed", { guildId: guildId.toString(), error: String(err) });
    await bot.helpers.editOriginalInteractionResponse(interaction.token, {
      // Not reported as a clean failure: if this threw partway, some records
      // already exist and the server is in a half-imported state. Saying
      // "failed" without that would send someone looking for nothing.
      content:
        `Import failed: ${String(err)}\n\n` +
        "Some records may already have been created. Check the server before retrying, or re-run with `replace: true` to start clean.",
    });
  }
}
