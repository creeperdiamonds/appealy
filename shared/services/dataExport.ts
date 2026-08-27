// shared/services/dataExport.ts
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
//
// ONE COPY, NOT TWO. This used to exist separately as
// bot/src/services/dataExportService.ts and api/src/services/
// dataExportService.ts, on the theory that the bot (Deno) and API (Node)
// run different db client instances so they needed different files. They
// didn't — the db handle is just a parameter, the same way
// shared/services/dataImport.ts already takes one, and both runtimes
// already import that file at the same relative path. What the old
// arrangement actually cost: its own header said "changes here should be
// mirrored there and vice versa," which is a synchronisation contract with
// no enforcement behind it, held together only by whoever remembered. It
// had already drifted once — the API copy picked up ban-appeal data the
// bot copy didn't have, so /export and the dashboard's export button
// produced different files for the same guild — and a second drift would
// fail exactly as silently as the first: no type error, no test failure,
// just two exports with different shapes depending on which surface built
// them. A single function with an injected db handle makes that class of
// bug structurally impossible instead of relying on discipline.
//
// Both runtimes call this — bot/src/commands/exportData.ts and
// api/src/routes/migration.ts.

import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema/schema.ts";

type Db = PostgresJsDatabase<typeof schema>;

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
  // The guild's own appeal against a platform ban on this server. User-level
  // appeals are excluded on purpose — see the query below.
  banAppeals: unknown[];
  // Previously missing entirely: a poll and its votes are a whole feature that
  // exported as nothing, outcomes and the appeal config are configuration an
  // admin built by hand, and gate overrides are deliberate per-user exceptions
  // someone set on purpose.
  //
  // dashboardAuditLogs stays out for the reason given at the top of this file.
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
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

export async function buildFullDataExport(db: Db, guildId: bigint): Promise<AppealyDataExport> {
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
    // fetched for this guild's forms via a subquery.
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
