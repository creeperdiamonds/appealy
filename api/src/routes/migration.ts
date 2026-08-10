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
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { requireOwnerAccess } from "../middleware/guildAccess.ts";
import { buildFullDataExport } from "../services/dataExportService.ts";
import { importAppySubmissions, type AppyExportRow } from "../services/appyImportService.ts";

export const migrationRouter = Router({ mergeParams: true });

migrationRouter.get("/export", requireOwnerAccess, async (req, res) => {
  const guildId = BigInt(req.params.guildId);
  const exportData = await buildFullDataExport(guildId);

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
  rows: z.array(appyRowSchema).min(1).max(5000),
});

migrationRouter.post("/migrate/appy-submissions", requireOwnerAccess, async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.flatten() });
  const { targetFormId, rows } = parsed.data;
  const guildId = BigInt(req.params.guildId);

  const form = await db.query.forms.findFirst({
    where: and(eq(schema.forms.id, targetFormId), eq(schema.forms.guildId, guildId)),
  });
  if (!form) return res.status(404).json({ error: "target_form_not_found" });

  try {
    const result = await importAppySubmissions(guildId, targetFormId, rows as AppyExportRow[]);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "import_failed", detail: String(err) });
  }
});
