// bot/src/services/dataExportService.ts
//
// Builds a complete, portable export of everything Appealy stores for one
// guild — forms, questions, panels, submissions/answers, DM templates,
// ticket configs/tickets, giveaways/entries, verification config,
// welcomer config, role menus, anti-raid config, quick responses, sticky
// messages, and staff permission delegations. Explicitly does NOT include
// billing/session data (guilds.customRateLimits, sessions,
// dashboardAuditLogs) — those are Appealy-hosting-account concerns, not
// portable server configuration, and dashboard_audit_logs specifically may
// contain other staff members' action history that isn't the requesting
// owner's alone to export wholesale.
//
// Snowflakes are serialized as strings throughout (never raw bigint, which
// doesn't round-trip through JSON.stringify), matching the Snowflake
// convention already used in shared/types/index.ts.

import { eq } from "drizzle-orm";
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
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
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
