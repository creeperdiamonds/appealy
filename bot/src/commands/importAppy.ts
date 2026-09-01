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
import {
  importAppySubmissions,
  MAX_IMPORT_ROWS,
  type AppyExportRow,
} from "../../../shared/services/appyImport.ts";
import { resolveEffectiveCaps } from "../services/rateLimitService.ts";
import { importedSubmissionCeiling } from "../../../shared/schema/pricing.ts";
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
  const attachment = resolveAttachment(interaction, attachmentId);

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

    // The API path has always enforced this through zod; the slash command
    // enforced nothing, so a 25 MB attachment could carry any number of rows.
    if (rows.length > MAX_IMPORT_ROWS) {
      await finish(
        bot,
        interaction,
        `That file has ${rows.length.toLocaleString()} rows, above the ${MAX_IMPORT_ROWS.toLocaleString()} accepted in one import. ` +
          `Split it and run the import again — re-running is safe, since anything already imported is recognised and skipped.`,
      );
      return;
    }

    const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
    if (!guild) {
      await finish(bot, interaction, "This server isn't set up yet. Run any command once, then retry the import.");
      return;
    }
    const ceiling = importedSubmissionCeiling(resolveEffectiveCaps(guild));

    const result = await importAppySubmissions(db, guildId, form.id, rows, { ceiling });

    if (result.ceilingExceeded) {
      const { stored, incoming, ceiling: limit } = result.ceilingExceeded;
      await finish(
        bot,
        interaction,
        `Import refused — nothing was written.\n\n` +
          `This server can hold **${limit.toLocaleString()}** imported submissions on its current plan` +
          `${stored > 0 ? `, and already holds ${stored.toLocaleString()}` : ""}. ` +
          `This file would add ${incoming.toLocaleString()} more.\n\n` +
          `Nothing was truncated: importing only part of a history would quietly discard real applications. ` +
          `Raise the limit by moving to a higher tier, or import into more than one form.`,
      );
      return;
    }

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

    const alreadySummary =
      result.alreadyImported > 0
        ? `\n${result.alreadyImported} submission(s) were already imported by a previous run and were left untouched.`
        : "";

    logger.info("Appy import completed", {
      guildId: guildId.toString(),
      formId: form.id,
      imported: result.imported,
      alreadyImported: result.alreadyImported,
      skipped: result.skipped.length,
      unmatchedQuestions: result.unmatchedQuestions.length,
    });

    await finish(
      bot,
      interaction,
      `Imported ${result.imported} submission(s) into **${form.name}**.${alreadySummary}${skippedSummary}${unmatchedSummary}`,
    );
  } catch (err) {
    logger.error("Appy import failed", { guildId: guildId.toString(), error: String(err) });
    await finish(
      bot,
      interaction,
      `Import failed: ${String(err)}. Anything imported before the failure is still there, and re-uploading the same file is the right way to finish — ` +
        `each submission carries its Appy id, so rows already imported are recognised and skipped rather than duplicated.`,
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

/**
 * Reads the uploaded attachment out of the interaction.
 *
 * Discordeno hands resolved attachments back as a Collection keyed by BigInt,
 * but attachment-option resolution is exactly the surface that shifts between
 * library versions, and README.md recorded this as an untested unknown.
 *
 * The previous code was one optional call — resolved?.attachments?.get?.(id) —
 * which does NOT throw when the shape is a plain object instead. It quietly
 * yields undefined, and the user is told "Could not read the uploaded file",
 * which reads like their mistake rather than ours.
 *
 * So all three plausible shapes are handled, and both key types are tried: a
 * Collection is keyed by BigInt, while a plain object deserialized from JSON
 * is keyed by string.
 */
type ResolvedAttachment = { filename: string; size: number; url: string };

function resolveAttachment(interaction: Interaction, attachmentId: unknown): ResolvedAttachment | undefined {
  if (attachmentId === undefined || attachmentId === null) return undefined;
  const raw = String(attachmentId);

  const attachments = interaction.data?.resolved?.attachments as
    | Map<unknown, ResolvedAttachment>
    | Record<string, ResolvedAttachment>
    | undefined;
  if (!attachments) return undefined;

  let asBigInt: bigint | undefined;
  try {
    asBigInt = BigInt(raw);
  } catch {
    // Not a snowflake, so only the string key can match.
  }

  if (typeof (attachments as Map<unknown, ResolvedAttachment>).get === "function") {
    const map = attachments as Map<unknown, ResolvedAttachment>;
    if (asBigInt !== undefined) {
      const hit = map.get(asBigInt);
      if (hit) return hit;
    }
    return map.get(raw);
  }

  return (attachments as Record<string, ResolvedAttachment>)[raw];
}

// Ephemeral flag now lives on the deferral; this wrapper just routes
// through finish() so call sites didn't need to change. NOT used by
// autocomplete() above — that handler must keep responding directly (see
// the comment on the defer() call in execute()).
async function respond(bot: AppealyBot, interaction: Interaction, content: string) {
  await finish(bot, interaction, content);
}
