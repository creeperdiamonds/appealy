// api/src/routes/migration.ts
//
// Owner-only data portability routes. Both actions here mirror the bot's
// /export and /import-appy slash commands and enforce the identical
// owner-only rule via requireOwnerAccess — see that middleware's comment
// for why this is scoped tighter than admin/manager access.
//
// GET /export streams the JSON directly as a download rather than DMing
// it (unlike the bot command, which has no other delivery mechanism) —
// the dashboard is already an authenticated, owner-only context by the
// time this response leaves the server, so there's no equivalent privacy
// concern to posting in a Discord channel.
//
// Mounted at /api/guilds/:guildId

import { Router } from "express";
import { routeParams } from "../utils/routeParams.ts";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireOwnerAccess } from "../middleware/guildAccess.ts";
import { buildFullDataExport } from "../../../shared/services/dataExport.ts";
import {
  importAppySubmissions,
  MAX_IMPORT_ROWS,
  type AppyExportRow,
} from "../../../shared/services/appyImport.ts";
import { resolveEffectiveCaps } from "../services/rateLimitService.ts";
import { importedSubmissionCeiling } from "../../../shared/schema/pricing.ts";
import { importGuildData } from "../../../shared/services/dataImport.ts";

export const migrationRouter = Router({ mergeParams: true });

migrationRouter.get("/export", requireOwnerAccess, async (req, res) => {
  const guildId = BigInt(routeParams(req).guildId);
  const exportData = await buildFullDataExport(db, guildId);

  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  const guildName = (guild?.name ?? guildId.toString()).replace(/[^a-z0-9]/gi, "_");
  const filename = `appealy-export-${guildName}-${new Date().toISOString().slice(0, 10)}.json`;

  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.json(exportData);
});

const appyRowSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  userId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  questions: z.array(z.object({ question: z.string(), answer: z.string() })),
  submissionDuration: z.number().optional(),
});

const importSchema = z.object({
  targetFormId: z.string(),
  rows: z.array(appyRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

migrationRouter.post("/migrate/appy-submissions", requireOwnerAccess, async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const { targetFormId, rows } = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, targetFormId), eq(schema.forms.guildId, guildId)),
  });
  if (!form) return res.status(404).json({ error: "target_form_not_found" });

  const guild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  if (!guild) return res.status(404).json({ error: "guild_not_found" });
  const ceiling = importedSubmissionCeiling(resolveEffectiveCaps(guild));

  try {
    const result = await importAppySubmissions(db, guildId, targetFormId, rows as AppyExportRow[], { ceiling });

    // 409, not 400: the request is well-formed and would have been accepted
    // on a higher tier. 402 would be the literal reading, but it is reserved
    // in practice and api.ts treats 4xx uniformly except for the 429 retry,
    // so the distinguishing signal has to be the body.
    if (result.ceilingExceeded) {
      return res.status(409).json({ error: "import_ceiling_exceeded", ...result });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "import_failed", detail: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Import an Appealy export into THIS guild.
//
// The receiving half of data portability: take the file /export produced in
// one server and stand the same configuration up in another. Owner-only, like
// the export — and for a sharper reason. Exporting is reading your own server;
// importing WRITES to it, and in replace mode deletes what is already there.
// That is not a thing to let a delegated manager do on the strength of a file
// they were handed.
//
// fallbackChannelId is required rather than optional because several columns
// the import writes are NOT NULL channel references. There is no way to say
// "unset" in the schema, so the caller has to say where things land until they
// are moved. Everything pointed there comes back in the report.
// ---------------------------------------------------------------------------

const idMapSchema = z.record(z.string().regex(/^\d{15,25}$/), z.string().regex(/^\d{15,25}$/));

const importSchemaAppealy = z.object({
  // The export file, parsed. Deliberately loose: an export from an older
  // version is missing keys rather than malformed, and the importer already
  // ignores what it does not recognise. Validating it strictly here would
  // reject the exact files this exists to accept.
  payload: z.record(z.string(), z.unknown()),
  fallbackChannelId: z.string().regex(/^\d{15,25}$/),
  mode: z.enum(["append", "replace"]).default("append"),
  // Source snowflake -> target snowflake. Optional, and the difference between
  // an import that works and one that needs an afternoon of reconnecting.
  idMap: idMapSchema.optional(),
});

migrationRouter.post("/migrate/import", requireOwnerAccess, async (req, res) => {
  const parsed = importSchemaAppealy.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  }
  const { payload, fallbackChannelId, mode, idMap } = parsed.data;
  const guildId = BigInt(routeParams(req).guildId);

  const targetGuild = await db.query.guilds.findFirst({ where: eq(schema.guilds.id, guildId) });
  if (!targetGuild) return res.status(404).json({ error: "guild_not_found" });

  try {
    const report = await importGuildData(db, payload, {
      targetGuildId: guildId,
      fallbackChannelId: BigInt(fallbackChannelId),
      actorId: req.userId!,
      idMap,
      mode,
      roleRuleLimit: resolveEffectiveCaps(targetGuild).rolesPerRuleType,
    });
    res.json(report);
  } catch (err) {
    // Deliberately not partial-success: if this throws midway the guild is
    // left with whatever was written before the failure, which the report
    // would not describe. Say so rather than returning a report that looks
    // complete.
    res.status(500).json({
      error: "import_failed",
      detail: String(err),
      warning:
        "The import stopped partway. Some records may already have been created — review the server before retrying, or retry in replace mode.",
    });
  }
});
