// bot/src/commands/importAppy.ts
//
// /import-appy <application_name> <file> — owner-only, imports an Appy
// submissions export (JSON file attachment) into an existing Appealy
// form. Same owner-only scoping as /export — this is a bulk write of
// historical data attributed to real applicants, not something a
// delegated admin should be able to trigger without the owner's own login.

import { ApplicationCommandTypes, ApplicationCommandOptionTypes } from "@discordeno/bot";
import type { AppealyInteraction as Interaction } from "../core/client.ts";
import type { CreateApplicationCommand } from "@discordeno/bot";
import type { AppealyBot } from "../core/client.ts";
import { db, schema } from "../db/client.ts";
import { eq, and, like } from "drizzle-orm";
import { isGuildOwner } from "../services/permissionService.ts";
import { importAppySubmissions, type AppyExportRow } from "../services/appyImportService.ts";
import { logger } from "../utils/logger.ts";
import { defer, finish } from "../utils/interactionResponse.ts";

export const definition: CreateApplicationCommand = {
  name: "import-appy",
  description: "Import Appy application submissions into an Appealy form (owner only)",
  type: ApplicationCommandTypes.ChatInput,
  options: [
    {
      name: "application_name",
      description: "The Appealy form to import submissions into",
      type: ApplicationCommandOptionTypes.String,
      required: true,
      autocomplete: true,
    },
    {
      name: "file",
      description: "The Appy submissions export (.json, from Appy's /export_applications)",
      type: ApplicationCommandOptionTypes.Attachment,
      required: true,
    },
  ],
};

export async function execute(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const requester = interaction.member?.user ?? interaction.user;
  if (!guildId || !requester) return;

  // isGuildOwner is a REST call, and the form lookup / attachment fetch /
  // import below are several more DB and REST round trips — plenty to blow
  // Discord's three-second first-response window. Deferring buys fifteen
  // minutes.
  //
  // This only covers `execute`. `autocomplete` below is a separate
  // interaction type (ApplicationCommandAutocomplete) that Discord only
  // accepts an immediate type: 8 response for — there is no deferred
  // variant for autocomplete, so it must keep responding to Discord
  // directly, the way both handlers did before this conversion. See the
  // dedicated guard test for this file in deferGuard.test.ts for why that
  // keeps it out of the generic MUST_DEFER list.
  await defer(bot, interaction, { ephemeral: true });

  const isOwner = await isGuildOwner(bot, guildId, requester.id);
  if (!isOwner) {
    return respond(bot, interaction, "Only the server owner can import data from another bot.");
  }

  const opts = Object.fromEntries((interaction.data?.options ?? []).map((o) => [o.name, o.value]));
  const formName = String(opts.application_name);
  const attachmentId = opts.file;
  const attachment = interaction.data?.resolved?.attachments?.get?.(BigInt(String(attachmentId)));

  if (!attachment) {
    return respond(bot, interaction, "Could not read the uploaded file. Please try again.");
  }
  if (!attachment.filename.toLowerCase().endsWith(".json")) {
    return respond(bot, interaction, "Please upload a .json file exported from Appy's `/export_applications` command.");
  }
  // Discord attachment size limits already bound this well below anything
  // that would need streaming, but a defensive ceiling avoids pulling an
  // unexpectedly huge file fully into memory.
  if (attachment.size > 25 * 1024 * 1024) {
    return respond(bot, interaction, "That file is too large. Split it into smaller exports if possible.");
  }

  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.guildId, guildId), eq(schema.forms.name, formName)),
  });
  if (!form) {
    return respond(bot, interaction, `No form found named **${formName}**. Create it first, then re-run this import.`);
  }

  await respond(bot, interaction, "Importing — this may take a moment for large histories...");

  try {
    const fileRes = await fetch(attachment.url);
    if (!fileRes.ok) throw new Error(`Failed to download attachment: ${fileRes.status}`);
    const raw = await fileRes.text();

    let rows: AppyExportRow[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Expected a JSON array at the top level.");
      rows = parsed;
    } catch (err) {
      await finish(bot, interaction, `That file isn't valid JSON in the expected shape: ${String(err)}`);
      return;
    }

    const result = await importAppySubmissions(guildId, form.id, rows);

    const unmatchedSummary =
      result.unmatchedQuestions.length > 0
        ? `\n\n${result.unmatchedQuestions.length} question(s) across the import couldn't be matched to a question on this form by text and were left out of the imported answers (the submission itself was still imported). This usually means the form's question wording has changed since the Appy export — you can re-run the import after aligning the wording, or accept the partial import as-is.`
        : "";

    const skippedSummary =
      result.skipped.length > 0
        ? `\n${result.skipped.length} submission(s) were skipped entirely: ${result.skipped
            .slice(0, 5)
            .map((s) => s.reason)
            .join("; ")}${result.skipped.length > 5 ? ", ..." : ""}`
        : "";

    logger.info("Appy import completed", {
      guildId: guildId.toString(),
      formId: form.id,
      imported: result.imported,
      skipped: result.skipped.length,
      unmatchedQuestions: result.unmatchedQuestions.length,
    });

    await finish(
      bot,
      interaction,
      `Imported ${result.imported} submission(s) into **${form.name}**.${skippedSummary}${unmatchedSummary}`,
    );
  } catch (err) {
    logger.error("Appy import failed", { guildId: guildId.toString(), error: String(err) });
    await finish(
      bot,
      interaction,
      `Import failed: ${String(err)}. No partial data was left in an inconsistent state — each submission is imported individually, so anything that succeeded before the failure is still there.`,
    );
  }
}

export async function autocomplete(bot: AppealyBot, interaction: Interaction) {
  const guildId = interaction.guildId;
  const typed = String(interaction.data?.options?.[0]?.value ?? "");
  if (!guildId) return;

  const matches = await db
    .select({ name: schema.forms.name })
    .from(schema.forms)
    .where(and(eq(schema.forms.guildId, guildId), like(schema.forms.name, `%${typed}%`)))
    .limit(25);

  await bot.helpers.sendInteractionResponse(interaction.id, interaction.token, {
    type: 8,
    data: { choices: matches.map((m) => ({ name: m.name, value: m.name })) },
  });
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change. NOT used by
// autocomplete() above — that handler must keep responding directly (see
// the comment on the defer() call in execute()).
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
