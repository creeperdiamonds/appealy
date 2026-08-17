// api/src/services/dataExportService.ts
//
// API-side counterpart to bot/src/services/dataExportService.ts. Both
// build the identical export shape from the identical schema — kept as
// two files rather than one shared module because the bot and API run in
// different runtimes (Deno vs Node) with separate db client instances,
// but the query logic and exported shape must never drift between them,
// so changes here should be mirrored there and vice versa.

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";

export interface AppealyDataExport {
  exportVersion: 1;
  exportedAt: string;
  guildId: string;
  forms: unknown[];
  panels: unknown[];
  submissions: unknown[];
  dmTemplates: unknown[];
  ticketConfigs: unknown[];
  tickets: unknown[];
  // Personal data that was previously missing from exports. Appeal bodies are
  // free text the user wrote about themselves; ban evidence typically contains
  // their message content. Both are plainly theirs under any subject-access
  // request, and omitting them made the export incomplete rather than minimal.
  banAppeals: unknown[];
  giveaways: unknown[];
  verificationConfig: unknown | null;
  welcomerConfig: unknown | null;
  roleMenus: unknown[];
  antiRaidConfig: unknown | null;
  quickResponses: unknown[];
  quickResponseCategories: unknown[];
  stickyMessages: unknown[];
  staffPermissions: unknown[];
}

function stringifyBigints<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export async function buildFullDataExport(guildId: bigint): Promise<AppealyDataExport> {
  const [
    forms,
    panels,
    panelButtons,
    submissions,
    dmTemplates,
    ticketConfigs,
    tickets,
    banAppeals,
    giveaways,
    verificationConfig,
    welcomerConfig,
    roleMenus,
    antiRaidConfig,
    quickResponses,
    quickResponseCategories,
    stickyMessages,
    staffPermissions,
  ] = await Promise.all([
    db.query.forms.findMany({ where: eq(schema.forms.guildId, guildId), with: { questions: true } }),
    db.query.panels.findMany({ where: eq(schema.panels.guildId, guildId) }),
    db.select().from(schema.panelButtons),
    db.query.submissions.findMany({ where: eq(schema.submissions.guildId, guildId), with: { answers: true } }),
    db.query.dmTemplates.findMany(),
    db.query.ticketConfigs.findMany({ where: eq(schema.ticketConfigs.guildId, guildId) }),
    db.query.tickets.findMany({ where: eq(schema.tickets.guildId, guildId) }),
    // Appeals against a ban on THIS guild — i.e. the guild owner appealing us
    // banning their server. Scoped by ban subject, not by member.
    //
    // User-level platform appeals are deliberately excluded: they're between
    // the individual and us, and a guild admin exporting their server should
    // not be able to read what one of their members wrote to us about a
    // personal ban. Those belong in a user-scoped export, not this one.
    db.query.platformBanAppeals.findMany({
      where: (a, { exists }) =>
        exists(
          db
            .select()
            .from(schema.platformBans)
            .where(
              and(
                eq(schema.platformBans.id, a.banId),
                eq(schema.platformBans.subject, "guild"),
                eq(schema.platformBans.subjectId, guildId),
              ),
            ),
        ),
    }),
    db.query.giveaways.findMany({ where: eq(schema.giveaways.guildId, guildId), with: { entries: true } }),
    db.query.verificationConfigs.findFirst({ where: eq(schema.verificationConfigs.guildId, guildId) }),
    db.query.welcomerConfigs.findFirst({ where: eq(schema.welcomerConfigs.guildId, guildId) }),
    db.query.roleMenus.findMany({ where: eq(schema.roleMenus.guildId, guildId), with: { options: true } }),
    db.query.antiRaidConfigs.findFirst({ where: eq(schema.antiRaidConfigs.guildId, guildId) }),
    db.query.quickResponses.findMany({ where: eq(schema.quickResponses.guildId, guildId) }),
    db.query.quickResponseCategories.findMany({ where: eq(schema.quickResponseCategories.guildId, guildId) }),
    db.query.stickyMessages.findMany({ where: eq(schema.stickyMessages.guildId, guildId) }),
    db.query.staffPermissions.findMany({ where: eq(schema.staffPermissions.guildId, guildId) }),
  ]);

  const formIds = new Set(forms.map((f) => f.id));
  const panelIds = new Set(panels.map((p) => p.id));
  const panelsWithButtons = panels.map((p) => ({
    ...p,
    buttons: panelButtons.filter((b) => panelIds.has(b.panelId) && b.panelId === p.id),
  }));
  const scopedDmTemplates = dmTemplates.filter((t) => formIds.has(t.formId));

  const exportData: AppealyDataExport = {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    guildId: guildId.toString(),
    forms,
    panels: panelsWithButtons,
    submissions,
    dmTemplates: scopedDmTemplates,
    ticketConfigs,
    tickets,
    giveaways,
    verificationConfig: verificationConfig ?? null,
    welcomerConfig: welcomerConfig ?? null,
    roleMenus,
    antiRaidConfig: antiRaidConfig ?? null,
    quickResponses,
    quickResponseCategories,
    stickyMessages,
    staffPermissions,
  };

  return stringifyBigints(exportData);
}
