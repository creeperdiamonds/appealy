// api/src/services/dataExportService.ts
//
// API-side counterpart to bot/src/services/dataExportService.ts. Both
// build the identical export shape from the identical schema — kept as
// two files rather than one shared module because the bot and API run in
// different runtimes (Deno vs Node) with separate db client instances,
// but the query logic and exported shape must never drift between them,
// so changes here should be mirrored there and vice versa.

import { and, eq, inArray } from "drizzle-orm";
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
  // Added because they were missing and are plainly the guild's own: a poll
  // and its votes are a whole feature that exported as nothing; outcomes and
  // the appeal config are configuration an admin built by hand; gate
  // overrides are deliberate per-user exceptions someone set on purpose.
  // "Everything Appealy stores for a guild" has to mean everything, or the
  // no-lock-in promise the export exists to keep is not kept.
  //
  // dashboardAuditLogs stays out, for the reason already given in the bot's
  // copy of this service: it is other staff members' action history, and
  // owner-only access does not make it the owner's alone to take.
  polls: unknown[];
  formOutcomes: unknown[];
  appealConfig: unknown | null;
  gateOverrides: unknown[];
  raidLockdowns: unknown[];
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
    polls,
    formOutcomes,
    appealConfig,
    gateOverrides,
    raidLockdowns,
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
    // Previously an unfiltered read of every guild's rows, narrowed in memory
    // afterwards. It produced the right output, but tenant isolation lived in
    // a .filter() rather than in the query, and it scanned the whole table on
    // every export. Same for dmTemplates below.
    db
      .select()
      .from(schema.panelButtons)
      .where(
        inArray(
          schema.panelButtons.panelId,
          db.select({ id: schema.panels.id }).from(schema.panels).where(eq(schema.panels.guildId, guildId)),
        ),
      ),
    db.query.submissions.findMany({ where: eq(schema.submissions.guildId, guildId), with: { answers: true } }),
    db.query.dmTemplates.findMany({
      where: inArray(
        schema.dmTemplates.formId,
        db.select({ id: schema.forms.id }).from(schema.forms).where(eq(schema.forms.guildId, guildId)),
      ),
    }),
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
    db.query.polls.findMany({ where: eq(schema.polls.guildId, guildId), with: { votes: true } }),
    // formOutcomes and gateOverrides hang off a form, not a guild, so they are
    // fetched for this guild's forms via a subquery rather than filtered in
    // memory afterwards — same reason the two below now carry a WHERE.
    db
      .select()
      .from(schema.formOutcomes)
      .where(
        inArray(
          schema.formOutcomes.formId,
          db.select({ id: schema.forms.id }).from(schema.forms).where(eq(schema.forms.guildId, guildId)),
        ),
      ),
    db.query.appealConfigs.findFirst({ where: eq(schema.appealConfigs.guildId, guildId) }),
    db
      .select()
      .from(schema.gateOverrides)
      .where(
        inArray(
          schema.gateOverrides.formId,
          db.select({ id: schema.forms.id }).from(schema.forms).where(eq(schema.forms.guildId, guildId)),
        ),
      ),
    db.query.raidLockdowns.findMany({ where: eq(schema.raidLockdowns.guildId, guildId) }),
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

  // Both panelButtons and dmTemplates are scoped by their queries now, so the
  // in-memory narrowing that used to stand in for it is gone rather than left
  // in place looking load-bearing. Grouping buttons under their panel is a
  // shaping step, not a filter.
  const panelsWithButtons = panels.map((p) => ({
    ...p,
    buttons: panelButtons.filter((b) => b.panelId === p.id),
  }));

  const exportData: AppealyDataExport = {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    guildId: guildId.toString(),
    forms,
    panels: panelsWithButtons,
    submissions,
    dmTemplates,
    ticketConfigs,
    tickets,
    // Queried above and then omitted from this literal, so every export
    // silently shipped without it — the exact gap the interface comment says
    // was being closed. It is the user's own free-text appeal bodies and the
    // evidence attached to them, which is the part of an export that most
    // needs to be there.
    banAppeals,
    polls,
    formOutcomes,
    appealConfig: appealConfig ?? null,
    gateOverrides,
    raidLockdowns,
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
